const wrtc = require('@roamhq/wrtc');
const caps = wrtc.RTCRtpReceiver.getCapabilities('video');
console.log('Video codecs:');
caps.codecs.forEach(c => console.log(' ', c.mimeType, 'clock', c.clockRate, 'params', JSON.stringify(c.sdpFmtpLine||'')));
const acaps = wrtc.RTCRtpReceiver.getCapabilities('audio');
console.log('Audio codecs:');
acaps.codecs.forEach(c => console.log(' ', c.mimeType, 'clock', c.clockRate));
