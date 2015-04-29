'use strict';

var bodyParser = require('body-parser');
var express = require('express');

exports.listen = function (listeningCb, signalCb) {
  var app = express();

  app.use(bodyParser.json());

  var self = this;

  app.get('/connectivity', function (req, res) {
    self.debug('← GET /connectivity');

    res.send({host: self.id});
  });

  app.post('/signal/:host', function (req, res) {
    var type = req.body.type;

    if (!type) {
      if (req.body.candidate) {
        type = 'candidate';
      } else {
        type = 'unknown type';
      }
    }

    self.debug('← POST /signal/%s %s', req.params.host, type);

    signalCb(req.params.host, req.body);

    res.send();
  });

  var server = app.listen(0, function () {
    listeningCb(server.address().port);
  });

  return app;
};
