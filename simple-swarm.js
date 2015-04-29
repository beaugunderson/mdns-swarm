#!/usr/bin/env node

'use strict';

var Swarm = require('./mdns-swarm.js');
var wrtc = require('wrtc');

var swarm = new Swarm('simple-swarm', {wrtc: wrtc});

swarm.on('peer', function (stream) {
  process.stdin.pipe(stream).pipe(process.stdout);
});
