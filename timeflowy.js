var fs = require('fs');
var http = require('http');
var https = require('https');
var moment = require('moment');
var querystring = require('querystring');

var tf = {};

tf.readConfigFile = function() {
  fs.readFile('config.json', 'utf-8', function (err, data) {
    if (err) {
      tf.writeError("FATAL file IO error: " + err);
      process.exit(-2);
    }
    // Make sure there's data before we post it
    if (data) {
      tf.config = JSON.parse(data);
      if (!tf.hasValidCookie()) {  //TODO: check expiration
        tf.login();
      }
    } else {
      tf.writeError("FATAL file IO error: no data");
      process.exit(-1);
    }
  });
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

tf.updateConfigFile = function() {
  fs.writeFile('config.json', JSON.stringify(tf.config, null, 2), function(err) {
    if (err) throw err;
  });
}

tf.writeError = function(message) {
  console.error(message);
  if (tf.response) {
    tf.response.writeHead(500, {"Content-Type": "text/plain"});
    tf.response.write(message);
    tf.response.end();
    tf.response = null;
  }
};

tf.getPage = function() {
  var get_options = {
    host: 'workflowy.com',
    port: '443',
    path: '/',
    method: 'GET',
    headers: {
      'Cookie': 'sessionid=' + tf.config.cookie.sessionid,
      'Host' : 'workflowy.com',
      'Referer': 'https://workflowy.com/',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/535.19 (KHTML, like Gecko) Ubuntu/10.04 Chromium/18.0.1025.168 Chrome/18.0.1025.168 Safari/535.19'
    }
  };
  var get_req = https.request(get_options, function(result) {
    result.on('data', function(data) {
      tf.response.writeHead(200, {"Content-Type": "text/plain"});
      tf.response.write(data);
      tf.response.end();
      tf.response = null;
    });
  });
  get_req.end();

  get_req.on('error', function(error) {
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

/* --- Begin --- */

// Read in the config file and login if needed.
tf.readConfigFile();

// Start the server.
http.createServer(function(request, response) {
  tf.response = response;
  if (tf.hasValidCookie()) {
    tf.getPage();
  } else {
    tf.login(tf.getPage);
  }
}).listen(8888);
