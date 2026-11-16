"""Tests for the voice service's timing helpers: python -m unittest voice/test_timing.py"""

import io
import unittest
import wave

import numpy as np

from timing import align, find_beats, resample, script_words, split_sentences, spread, to_wav


class Text(unittest.TestCase):
    def test_sentences(self):
        s = split_sentences("Hi. Welcome to Gamface!  Today we test the new reel.\n\nIt's fast? Yes.")
        self.assertEqual(s, ["Hi. Welcome to Gamface!", "Today we test the new reel.", "It's fast? Yes."])

    def test_long_sentence_split(self):
        long = ", ".join(["this part is fine"] * 40) + "."
        parts = split_sentences(long, max_chars=100)
        self.assertTrue(all(len(p) <= 101 for p in parts))
        self.assertEqual(" ".join(parts).replace("  ", " "), long)

    def test_script_words_keep_punctuation(self):
        self.assertEqual(script_words("Fast — and cheap , really!"), ["Fast —", "and", "cheap,", "really!"])


class Words(unittest.TestCase):
    def test_spread_covers_sentence(self):
        w = spread([("One two three.", 0.0, 1.5), ("Four.", 1.7, 2.2)])
        self.assertEqual([x["text"] for x in w], ["One", "two", "three.", "Four."])
        self.assertEqual(w[0]["start"], 0.0)
        self.assertAlmostEqual(w[2]["end"], 1.5, places=3)
        self.assertEqual(w[3]["start"], 1.7)

    def test_align_uses_heard_times_and_script_spelling(self):
        script = script_words("Gamface launches today, at 9 AM.")
        heard = [("Gameface", 0.1, 0.5), ("launches", 0.5, 0.9), ("today,", 0.9, 1.3), ("at", 1.4, 1.5), ("nine", 1.5, 1.8), ("AM.", 1.8, 2.1)]
        w = align(script, heard, 2.4)
        self.assertEqual([x["text"] for x in w], script)
        self.assertEqual((w[1]["start"], w[1]["end"]), (0.5, 0.9))
        # Misheard words fall between their neighbours
        self.assertTrue(0.0 <= w[0]["start"] < w[0]["end"] <= 0.5 + 1e-9)
        self.assertTrue(1.5 <= w[4]["start"] < w[4]["end"] <= 1.8 + 1e-9)
        # Always in order
        self.assertTrue(all(a["start"] <= b["start"] for a, b in zip(w, w[1:])))

    def test_align_without_whisper(self):
        w = align(["a", "bb", "ccc"], [], 3.0)
        self.assertEqual(w[0]["start"], 0.0)
        self.assertAlmostEqual(w[-1]["end"], 3.0, places=3)


class Audio(unittest.TestCase):
    def test_wav(self):
        data = to_wav(np.sin(np.linspace(0, 100, 24000)).astype(np.float32), 24000)
        with wave.open(io.BytesIO(data)) as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getnframes()), (24000, 1, 24000))

    def test_resample(self):
        self.assertEqual(len(resample(np.zeros(24000, dtype=np.float32), 24000, 16000)), 16000)

    def click_track(self, bpm, seconds=12, sr=16000, offset=0.3):
        rng = np.random.default_rng(1)
        x = rng.normal(0, 0.02, int(seconds * sr)).astype(np.float32)
        period = 60 / bpm
        t = offset
        while t < seconds - 0.05:
            i = int(t * sr)
            n = int(0.03 * sr)
            x[i : i + n] += (rng.normal(0, 0.8, n) * np.exp(-np.linspace(0, 8, n))).astype(np.float32)
            t += period
        return x, sr, period, offset

    def test_beats_120(self):
        x, sr, period, offset = self.click_track(120)
        out = find_beats(x, sr)
        self.assertAlmostEqual(out["tempo"], 120, delta=3)
        beats = np.array(out["beats"])
        self.assertGreater(len(beats), 18)
        # Each beat sits close to a click
        err = np.abs(((beats - offset) / period) - np.round((beats - offset) / period)) * period
        self.assertLess(np.median(err), 0.03)

    def test_beats_95(self):
        x, sr, *_ = self.click_track(95)
        self.assertAlmostEqual(find_beats(x, sr)["tempo"], 95, delta=3)

    def test_silence_has_no_beats(self):
        self.assertEqual(find_beats(np.zeros(16000 * 3, dtype=np.float32), 16000)["beats"], [])


if __name__ == "__main__":
    unittest.main()
