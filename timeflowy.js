var fs = require('fs');
var http = require('http');
var https = require('https');
var moment = require('moment');
var querystring = require('querystring');

var tf = {};

tf.readConfigFile = function() {
  var json = fs.readFileSync('config.json');
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
  fs.writeFile('config.json', JSON.stringify(tf.config, null, 2), function(err) {
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
      tf.crawlTree({nm : 'Root'}, treeInfo.rootProjectChildren);
      tf.writeResponse(tf.events.toString());
      break;
    }
  }
  if (i == lines.length) {
    tf.writeError('Could not find "var mainProjectTreeInfo" assignment.');
  }  
};

tf.crawlTree = function(parent, node) {
  if (node.no) {  // 'no' for "note"
    // date annotations should alone on just one line of the note
    var lines = node.no.split('\n');
    var start, end;
    for (var i = 0; i < lines.length; i++) {
      var range = line.split(tf.config.range_delimiter);
      if (range.length == 2) {
        // the first part of the range must always have a date but may not have a time
        start = moment(range[0], config.date_time_format);
        if (start._is_valid === false) {
           // no time specified, second part of range must only be a date
           if (start.year() === 0) {
             continue;  // actually, not a date at all, bail
           }
           end = moment(range[1], config.date_format);
        } else {
          // time was specified, second part could be date_time or just time
          end = moment(range[1], config.date_time_format);
          if (end._is_valid === false) {
            var endTime = moment(range[1], config.time_format);
            end = moment([start.year(),
                          start.month(),
                          start.day(),
                          endTime.hour(),
                          endTime.minute()]);
          }
        }
      } else {
        start = moment(range[0], config.date_time_format);
        if (start._is_valid === false) {
          // just a date specified
          if (start.year() === 0) {
            continue;  // actually, not a date at all, bail
          }
          end = start;
        } else {
          end = moment(start).add('m', config.default_duration_minutes);
        }
      }
    }
    if (start && end) {
      tf.events.push(new tf.Event(start, end));
    }
  }
  if (node.ch) {
    node.ch.forEach(function(child) {
      tf.crawlTree(node, child);
    });
  }
};

tf.Event = function(start, end) {
  this.start = start;
  this.end = end;
};

tf.Event.prototype.toString = function() {
  return this.start.toString + ' ' + this.end.toString();
};

/* --- Begin --- */

// Read in the config file and login if needed.
tf.readConfigFile();

// Start the server.
http.createServer(function(request, response) {
  tf.events = [];
  tf.response = response;
  if (tf.hasValidCookie()) {
    tf.getPage();
  } else {
    tf.login(tf.getPage);
  }
}).listen(8888);
