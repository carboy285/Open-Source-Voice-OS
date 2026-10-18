using System;
using System.Collections.Generic;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Murmur
{
    /// <summary>WASAPI microphone capture, converted to 16 kHz mono PCM16 in memory.</summary>
    public sealed class AudioCapture
    {
        private WasapiCapture? capture;
        private readonly List<float> mono = new();
        private readonly object gate = new();
        private int sourceRate = 48000;

        /// <summary>0..1, for the listening indicator. Raised on a capture thread.</summary>
        public event Action<float>? Level;

        public bool IsRecording => capture != null;

        public void Start()
        {
            if (capture != null) return;
            lock (gate) mono.Clear();
            var device = new MMDeviceEnumerator().GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
            var next = new WasapiCapture(device, true, 20);
            sourceRate = next.WaveFormat.SampleRate;
            next.DataAvailable += OnData;
            next.StartRecording();
            capture = next;
        }

        /// <summary>Stops recording and returns 16 kHz mono PCM16 bytes. The buffer is cleared.</summary>
        public byte[] Stop()
        {
            var current = capture;
            capture = null;
            if (current == null) return Array.Empty<byte>();
            current.DataAvailable -= OnData;
            try { current.StopRecording(); } catch (InvalidOperationException) { }
            current.Dispose();
            float[] samples;
            lock (gate)
            {
                samples = mono.ToArray();
                mono.Clear();
            }
            return Resample(samples, sourceRate);
        }

        private void OnData(object? sender, WaveInEventArgs e)
        {
            if (sender is not WasapiCapture source) return;
            var format = source.WaveFormat;
            var channels = Math.Max(1, format.Channels);
            var isFloat = format.Encoding == WaveFormatEncoding.IeeeFloat ||
                          (format.Encoding == WaveFormatEncoding.Extensible && format.BitsPerSample == 32);
            var bytesPerSample = format.BitsPerSample / 8;
            var frames = e.BytesRecorded / (bytesPerSample * channels);
            double sum = 0;
            lock (gate)
            {
                for (var frame = 0; frame < frames; frame++)
                {
                    float value = 0;
                    for (var channel = 0; channel < channels; channel++)
                    {
                        var offset = (frame * channels + channel) * bytesPerSample;
                        value += isFloat
                            ? BitConverter.ToSingle(e.Buffer, offset)
                            : bytesPerSample == 2 ? BitConverter.ToInt16(e.Buffer, offset) / 32768f
                            : BitConverter.ToInt32(e.Buffer, offset) / 2147483648f;
                    }
                    value /= channels;
                    mono.Add(value);
                    sum += value * value;
                }
            }
            if (frames > 0) Level?.Invoke((float)Math.Min(1, Math.Sqrt(sum / frames) * 6));
        }

        private static byte[] Resample(float[] samples, int rate)
        {
            if (samples.Length == 0) return Array.Empty<byte>();
            var source = new FloatArrayProvider(samples, rate);
            ISampleProvider provider = rate == 16000 ? source : new WdlResamplingSampleProvider(source, 16000);
            var output = new List<byte>(samples.Length);
            var buffer = new float[4096];
            int read;
            while ((read = provider.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (var i = 0; i < read; i++)
                {
                    var value = (short)Math.Clamp(buffer[i] * 32767f, short.MinValue, short.MaxValue);
                    output.Add((byte)(value & 0xFF));
                    output.Add((byte)((value >> 8) & 0xFF));
                }
            }
            return output.ToArray();
        }

        private sealed class FloatArrayProvider : ISampleProvider
        {
            private readonly float[] samples;
            private int position;

            public FloatArrayProvider(float[] samples, int rate)
            {
                this.samples = samples;
                WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(rate, 1);
            }

            public WaveFormat WaveFormat { get; }

            public int Read(float[] buffer, int offset, int count)
            {
                var n = Math.Min(count, samples.Length - position);
                Array.Copy(samples, position, buffer, offset, n);
                position += n;
                return n;
            }
        }
    }
}
