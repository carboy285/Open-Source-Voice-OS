// Hidden page that owns the microphone. Serialize IPC commands because opening a microphone is asynchronous.
let stream, context, source, node, chunks = [];
let pending = Promise.resolve();

const workletSource = `
  class Tap extends AudioWorkletProcessor {
    process(inputs) {
      const channel = inputs[0] && inputs[0][0];
      if (channel) this.port.postMessage(channel.slice(0));
      return true;
    }
  }
  registerProcessor("tap", Tap);`;

async function start() {
  chunks = [];
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  context = new AudioContext();
  const url = URL.createObjectURL(new Blob([workletSource], { type: "application/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  source = context.createMediaStreamSource(stream);
  node = new AudioWorkletNode(context, "tap");
  node.port.onmessage = (event) => chunks.push(event.data);
  source.connect(node);
  // Keep the worklet in the active graph. It leaves its output silent; microphone audio is never played back.
  node.connect(context.destination);
}

async function teardown() {
  source && source.disconnect();
  node && node.disconnect();
  stream && stream.getTracks().forEach((track) => track.stop());
  const rate = context ? context.sampleRate : 48000;
  const closing = context;
  source = node = stream = context = undefined;
  if (closing) await closing.close();
  return rate;
}

function enqueue(action) {
  pending = pending.then(action).catch(async (error) => {
    await teardown().catch(() => undefined);
    chunks = [];
    window.voiceos.sendRecorderError(String(error && error.message || error));
  });
  return pending;
}

window.voiceos.onRecorderStart(() => enqueue(start));
window.voiceos.onRecorderStop(() => enqueue(async () => {
  const rate = await teardown();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
  chunks = [];
  window.voiceos.sendAudio(samples, rate);
}));
window.voiceos.onRecorderCancel(() => enqueue(async () => {
  await teardown();
  chunks = [];
}));
