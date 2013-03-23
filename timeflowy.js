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
};

tf.updateConfigFile = function() {
  fs.writeFile('config.json', JSON.stringify(tf.config, null, 2), function(err) {
    if (err) throw err;
  });
}

tf.writeError = function(message) {
  console.log(message);
  if (tf.response) {
    tf.response.writeHead(500, {"Content-Type": "text/plain"});
    tf.response.write(message);
    tf.response.end();
    tf.response = null;
  }
};

tf.getPage = function() {
    tf.response.writeHead(200, {"Content-Type": "text/plain"});
    tf.response.write("getPage()");
    tf.response.end();
    tf.response = null;
}

tf.readCookie = function(headers) {
  tf.config.cookie = {};
  var cookieText = headers['set-cookie'] && headers['set-cookie'][0];
  cookieText.split('; ').forEach(function(item) {
    var keyVal = item.split('=');
    switch (keyVal[0]) {
    case "sessionid":
      tf.config.cookie.sessionid = keyVal[1];
      break;
    case "expires":
      tf.config.cookie.expires = keyVal[1];
      break;
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
