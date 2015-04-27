#!/usr/bin/env node

'use strict';

var Swarm = require('./mdns-swarm.js');

var swarm = new Swarm('simple-swarm');

swarm.on('peer', function (stream) {
  process.stdin.pipe(stream).pipe(process.stdout);
});
