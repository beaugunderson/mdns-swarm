'use strict';

var bodyParser = require('body-parser');
var debug = require('debug')('signal-server');
var express = require('express');

var app = express();

app.use(bodyParser.json());

exports.listen = function (me, listeningCb, signalCb) {
  app.get('/connectivity', function (req, res) {
    debug('← GET /connectivity');

    res.send({host: me});
  });

  app.post('/signal/:host', function (req, res) {
    debug('← POST /signal/' + req.params.host);

    signalCb(req.params.host, req.body);

    res.send();
  });

  var server = app.listen(0, function () {
    var port = server.address().port;

    debug('listening on', port);

    listeningCb(port);
  });

  return app;
};
