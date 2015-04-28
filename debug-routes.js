'use strict';

var async = require('async');
var debug = require('debug')('signal-server');
var request = require('request');
var _ = require('lodash');

module.exports = function (app) {
  // this function is called with `this` bound to the Swarm instance
  var self = this;

  app.get('/debug.html', function (req, res) {
    var path = require('path');

    res.sendFile(path.join(__dirname, 'debug.html'));
  });

  app.get('/debug', function (req, res) {
    var hosts = _.keys(self._peers);

    var connections = hosts.map(function (host) {
      return self.connectivity[host];
    });

    var mine = _.zipObject(hosts, connections);

    if (req.query.all) {
      debug('← GET /debug?all=true');

      async.map(hosts, function (host, cbMap) {
        debug('→ GET /debug %s', host);

        request.get({
          url: self.connectivity[host] + 'debug',
          json: true
        }, function (err, response, body) {
          var result = {host: host};

          if (err || !body) {
            result.connections = self.connectivity[host];
          } else {
            result.connections = body;
          }

          cbMap(null, result);
        });
      }, function (err, results) {
        if (err) {
          return res.send({error: err});
        }

        var resultsObject = _.zipObject(_.pluck(results, 'host'),
                                        _.pluck(results, 'connections'));


        resultsObject[self] = mine;

        res.send(resultsObject);
      });

      return;
    }

    debug('← GET /debug');

    res.send(mine);
  });
};
