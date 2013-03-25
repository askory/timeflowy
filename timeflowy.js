var fs = require('fs');
var http = require('http');
var https = require('https');
var icalendar = require('icalendar');
var moment = require('moment');
var querystring = require('querystring');

var CONFIG_FILE = __dirname + '/config.json';

var tf = {};

tf.readConfigFile = function() {
  var json = fs.readFileSync(CONFIG_FILE);
  tf.config = JSON.parse(json);
  if (!tf.hasValidCookie()) {
    tf.login();
  }
}

tf.login = function(opt_callback) {
  var post_data = querystring.stringify({
     username: tf.config.username,
     password: tf.config.password 
  });
  var post_options = {
    host: 'workflowy.com',
    port: '443',
    path: '/accounts/login/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': post_data.length
    }
  };
  var post_req = https.request(post_options, function(result) {
    result.setEncoding('utf8');
    tf.readCookie(result.headers);
    if (tf.hasValidCookie()) {
      tf.updateConfigFile();
      if (opt_callback) {
        opt_callback();
      }
    } else {
      tf.writeError('FATAL no cookie returned: ' + JSON.stringify(result.headers));
      process.exit(-2);
    }
  });
  post_req.write(post_data);
  post_req.end();

  post_req.on('error', function(error) {
    tf.writeError(error);
  });
};

tf.readCookie = function(headers) {
  tf.config.cookie = {};
  var cookieText = headers['set-cookie'] && headers['set-cookie'][0];
  cookieText.split('; ').forEach(function(item) {
    var keyVal = item.split('=');
    if (keyVal[0] == 'sessionid' || keyVal[0] == 'expires') {
      tf.config.cookie[keyVal[0]] = keyVal[1];
    }
  });
};
      
tf.hasValidCookie = function() {
  return tf.config.cookie
      && tf.config.cookie.sessionid
      && tf.config.cookie.expires
      && Date.parse(tf.config.cookie.expires) > Date.now(); 
}

tf.updateConfigFile = function() {
  fs.writeFile(CONFIG_FILE, JSON.stringify(tf.config, null, 2), function(err) {
    if (err) throw err;
  });
}

tf.writeError = function(message) {
  console.error(message);
  if (tf.response) {
    tf.response.writeHead(500, {'Content-Type': 'text/plain'});
    tf.response.write(message);
    tf.response.end();
    tf.response = null;
  }
};

tf.writeResponse = function(data) {
  if (tf.response != null) {
    tf.response.writeHead(200, {'Content-Type': 'text/plain'});
    tf.response.write(data);
    tf.response.end();
    tf.response = null;
  }
};

tf.getGetOptions = function(path) {
  return {
    host: 'workflowy.com',
    port: '443',
    path: path,
    method: 'GET',
    headers: {
      'Cookie': 'sessionid=' + tf.config.cookie.sessionid,
      'Host' : 'workflowy.com',
      'Referer': 'https://workflowy.com/',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/535.19 (KHTML, like Gecko) Ubuntu/10.04 Chromium/18.0.1025.168 Chrome/18.0.1025.168 Safari/535.19'
    }
  };
};

tf.getPage = function() {
  var get_options = tf.getGetOptions('/');
  var get_req = https.request(get_options, function(result) {
    var found = false;
    result.on('data', function(data) {
      // If successfully logged in, there will be a <script /> tag in the page to load
      // an external script with the current project tree embedded therein. Find the
      // src of this script. I'm assumming the "?t=..." part is timestamp and that it's
      // needed.
      var match = data.toString().match(/\/get_project_tree_data\?t=[A-Za-z0-9_]+/);
      if (match && match[0]) {
        found = true;
        tf.loadProjectTreeScript(match[0]);
      }
    });
    result.on('end', function() {
      if (!found) {
        tf.writeError('Could not find getProjectTreeData script src.');
      }
    });
  });
  get_req.end();

  get_req.on('error', function(error) {
    tf.writeError(error);
  });
};

tf.loadProjectTreeScript = function(scriptSrc) {
  var get_options = tf.getGetOptions(scriptSrc);
  var get_req = https.request(get_options, function(result) {
    var scriptText = '';
    result.on('data', function(data) {
      scriptText += data.toString();
    });
    result.on('end', function() {
      tf.findMainInfo(scriptText);
    });
  });
  get_req.end();

  get_req.on('error', function(error) {
    tf.writeError(error);
  });
};

tf.findMainInfo = function(scriptText) {
  // Probably the most fragile assumption in the script; look for a
  // single line assigning var mainProjectTreeInfo to an object,
  // then get the object itself as JSON...
  var lines = scriptText.split('\n');
  var i;
  for (i = 0; i < lines.length; i++) {
    var checkAssignment = lines[i].split('var mainProjectTreeInfo = ');
    if (checkAssignment.length == 2) {
      var json = checkAssignment[1].substr(0, checkAssignment[1].length - 1);
      var treeInfo = JSON.parse(json);
      // There is actually no root node, so make a dummy one with title "Root."
      var root = {nm : 'Root'};
      treeInfo.rootProjectChildren.forEach(function(child) {
        tf.crawlTree(root, child);
      });
      tf.makeCalendar();
      break;
    }
  }
  if (i == lines.length) {
    tf.writeError('Could not find "var mainProjectTreeInfo" assignment.');
  }  
};

tf.crawlTree = function(parent, node) {
  var event = tf.Event.fromNode(parent, node);
  if (event) {
    tf.events.push(event);
  }
  if (node.ch && node.ch.length > 0) {  // 'ch' for "children"
    node.ch.forEach(function(child) {
      tf.crawlTree(node, child);
    });
  }
};

tf.Event = function(parent, node, start, end) {
  this.parent = parent;
  this.node = node;
  this.start = start;
  this.end = end;
};

tf.Event.parseDateTime = function(input) {
  // the first part of the range must always have a date but may not have a time
  return tf.FORMATS.DATE_TIME.parse(input)
      || tf.FORMATS.DATE.parse(input)
      || tf.FORMATS.TIME.parse(input);
};

tf.Event.fromNode = function(parent, node) {
  if (node.no) {  // 'no' for "note"
    // date annotations should be alone on just one line of the note.
    // only the first matching line will be used.
    var lines = node.no.split('\n');
    var start, end;
    for (var i = 0; i < lines.length; i++) {
      var range = lines[i].split(tf.FORMATS.RANGE_DELIMITER);
      start = tf.Event.parseDateTime(range[0]);
      // skip this line if no valid start found, or the start was only time w/o date
      if (!start || tf.FORMATS.TIME.is(start)) continue;
      if (range.length == 2) {  // an end was specified using the delimiter
        end = tf.Event.parseDateTime(range[1]);
        // skip this line if no valid end found
        if (!end) continue;
        if (tf.FORMATS.DATE.is(end)) {
          // the end is only a date, which means really it should be midnight
          // of the *following* day
          end.add('d', 1);
        } else if (tf.FORMATS.TIME.is(end)) {
          // the end is only a time, make its date the same as start's
          end = moment([start.year(),
                        start.month(),
                        start.date(),
                        end.hour(),
                        end.minute()]);
        }
      } else {  // no end specified
          if (tf.FORMATS.DATE.is(start)) {  // just a date
          end = moment(start).add('d', 1);
        } else {
          end = moment(start).add('m', tf.config.default_duration_minutes);
        }
      }
      if (start && end) {
        return new tf.Event(parent, node, start, end);
      }
    }
  }
  return null;
};

tf.Event.prototype.toIcal = function() {
  var icalEvent = new icalendar.VEvent(this.node.id);
  icalEvent.setDate(this.start.toDate(), this.end.toDate());
  icalEvent.setSummary(this.node.nm);
  var desc = this.parent.nm + ' > ' + this.node.nm;
  if (this.node.ch) {
    for (var i = 0; i < this.node.ch.length; i++) {
      desc += '\n    - ' + this.node.ch[i].nm;
    }
  }
  desc += '\n\nhttps://workflowy.com/#/' + this.node.id;
  icalEvent.setDescription(desc);
  return icalEvent;
};

tf.Event.prototype.toString = function() {
  return this.node.nm + ':\n'
      + this.start.toString() + tf.FORMATS.RANGE_DELIMITER + this.end.toString()
      + '\n\n';
};

// Note: the moment library is very forgiving when parsing
// strings in that it seems to consider all non-alpha chars
// the same. This unfortunately makes verifying input pretty
// hard. So, I'm hard-coding some regexs cuz that's easy.
tf.Format = function(pattern, regex) {
  this.pattern = pattern;
  this.regex = regex;
};

tf.Format.prototype.parse = function(input) {
  return input.match(this.regex) ? moment(input, this.pattern) : null;
};

tf.Format.prototype.is = function(date_time) {
  return date_time._f == this.pattern;
};

// TODO: make date formatting fully configurable
tf.FORMATS = {
  RANGE_DELIMITER: ' .. ',
  DATE: new tf.Format('YYYY-MM-DD', /^\d{4}-\d{1,2}-\d{1,2}$/),
  TIME: new tf.Format('HH:mm', /^\d{1,2}:\d{1,2}$/),
  DATE_TIME: new tf.Format('YYYY-MM-DD HH:mm', /^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{1,2}$/)
}

tf.makeCalendar = function() {
  var ical = new icalendar.iCalendar();
  ical.addProperty('X-WR-CALNAME', 'Workflowy');
  ical.addProperty('X-WR-CALDESC', 'Exported with timeflowy. https://github.com/askory/timeflowy');
  tf.events.forEach(function(event) {
    ical.addComponent(event.toIcal());
  });
  tf.writeResponse(ical.toString());
};

/* --- Begin --- */

// Read in the config file and login if needed.
tf.readConfigFile();

// Start the server.
http.createServer(function(request, response) {
  // TODO: something smarter than hardcoding the key
  if (request.url.search(tf.config.key) == -1) {
    response.writeHead(403, {'Content-Type': 'text/plain'});
    response.write('Nope.');
    response.end();
    return;
  }
  tf.events = [];
  tf.response = response;
  if (tf.hasValidCookie()) {
    tf.getPage();
  } else {
    tf.login(tf.getPage);
  }
}).listen(tf.config.port);
