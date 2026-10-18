using System;
using System.IO;
using System.Media;

namespace Murmur
{
    /// <summary>One soft cue, synthesized in memory: a short rising tone for start, falling for stop.</summary>
    internal static class Sound
    {
        private static readonly byte[] StartWav = Tone(660, 880);
        private static readonly byte[] StopWav = Tone(880, 660);

        public static void Play(bool start, bool enabled)
        {
            if (!enabled) return;
            try { new SoundPlayer(new MemoryStream(start ? StartWav : StopWav)).Play(); }
            catch (InvalidOperationException) { }
        }

        private static byte[] Tone(double from, double to, int rate = 44100, double seconds = 0.09)
        {
            var count = (int)(rate * seconds);
            using var stream = new MemoryStream();
            using var writer = new BinaryWriter(stream);
            writer.Write("RIFF"u8.ToArray());
            writer.Write(36 + count * 2);
            writer.Write("WAVEfmt "u8.ToArray());
            writer.Write(16);
            writer.Write((short)1);
            writer.Write((short)1);
            writer.Write(rate);
            writer.Write(rate * 2);
            writer.Write((short)2);
            writer.Write((short)16);
            writer.Write("data"u8.ToArray());
            writer.Write(count * 2);
            double phase = 0;
            for (var i = 0; i < count; i++)
            {
                var t = (double)i / count;
                phase += 2 * Math.PI * (from + (to - from) * t) / rate;
                var sample = Math.Sin(phase) * Math.Sin(Math.PI * t) * 0.15;
                writer.Write((short)(sample * short.MaxValue));
            }
            writer.Flush();
            return stream.ToArray();
        }
    }
}
