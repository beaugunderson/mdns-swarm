## mdns-swarm

create a swarm of connected webrtc peers using multicast DNS!

### Example

Try this on two computers on the same network; for debug information you can
run with `DEBUG=mdns-swarm*`.

```js
var Swarm = require('./mdns-swarm.js');
var wrtc = require('wrtc');

var swarm = new Swarm('simple-swarm', {wrtc: wrtc});

swarm.on('peer', function (stream) {
  process.stdin.pipe(stream).pipe(process.stdout);
});
```
