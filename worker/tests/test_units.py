"""Pure-function tests (no ffmpeg, network or server). Run: python -m unittest discover -s tests"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from slideshow_worker.sfx import openverse, rank  # noqa: E402
from slideshow_worker.text import find_phrase, normalize_phrase, tokens, word_error_rate  # noqa: E402
from slideshow_worker.timeline import caption_cues, cue_window, layout, place_cues, place_words, segment_qa, to_srt  # noqa: E402


def seg(id_, order, **kw):
    base = {"id": id_, "order": order, "type": "illustration", "narration": "", "image": {"prompt": "p"}}
    base.update(kw)
    return base


def episode(segments, **kw):
    ep = {
        "segments": segments,
        "voice": {"pause_between_segments_ms": 500},
        "render": {"fps": 30, "intro_sec": 1.0, "outro_sec": 2.0},
        "audio": {"sfx_default_gain_db": -18},
    }
    ep.update(kw)
    return ep


class TextTests(unittest.TestCase):
    def test_normalize_matches_typescript_rules(self):
        self.assertEqual(normalize_phrase("  Don’t   STOP—now! "), "don't stop now")
        self.assertEqual(tokens("Hello, world... it's 9am"), ["hello", "world", "it's", "9am"])

    def test_wer(self):
        self.assertEqual(word_error_rate(["a", "b", "c"], ["a", "b", "c"]), 0.0)
        self.assertAlmostEqual(word_error_rate(["a", "b", "c", "d"], ["a", "x", "c"]), 0.5)
        self.assertEqual(word_error_rate([], []), 0.0)

    def test_find_phrase(self):
        words = [{"word": w} for w in ["The", "door", "slammed", "shut."]]
        self.assertEqual(find_phrase("slammed shut", words), 2)
        self.assertIsNone(find_phrase("window", words))


class TimelineTests(unittest.TestCase):
    def setUp(self):
        self.ep = episode(
            [
                seg("seg_001", 1, narration="The door slammed shut behind them.", transition_out="crossfade_150ms",
                    sfx=[{"id": "sfx_1", "placement": "at_phrase", "at_phrase": "slammed shut"},
                         {"id": "sfx_2", "placement": "whole_segment", "loop": True, "continues_into_next": True, "gain_db": -24}]),
                seg("seg_002", 2, type="infographic", image=None),
                seg("seg_003", 3, type="reuse_image", narration="Quiet.", image={"reuse_from_segment_id": "seg_001"}),
            ]
        )

    def test_layout(self):
        t = layout(self.ep, {"seg_001": 3.0, "seg_003": 1.0})
        s1, s2, s3 = t["segments"]
        self.assertEqual((s1["start"], s1["end"], s1["voice_start"]), (1.0, 4.5, 1.0))
        self.assertEqual((s2["start"], s2["end"], s2["voice_start"]), (4.5, 7.0, None))
        self.assertEqual(s2["display"], "card/seg_002")
        self.assertEqual(s3["display"], "image/seg_001")
        self.assertEqual(s3["end"], 8.5)
        self.assertEqual(t["total_duration"], 10.5)

    def test_cues_and_qa(self):
        t = layout(self.ep, {"seg_001": 3.0, "seg_003": 1.0})
        rel = [{"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4} for i, w in enumerate(["The", "door", "slammed", "shut", "behind", "them."])]
        place_words(t, {"seg_001": rel})
        warnings = place_cues(self.ep, t)
        self.assertEqual(warnings, [])
        c1, c2 = t["cues"]
        self.assertEqual(c1["anchor"], 2.0)
        self.assertEqual(c1["gain_db"], -18)
        self.assertEqual(c2["segment_end"], 7.0)
        self.assertEqual(cue_window(c1, 1.2, t["total_duration"]), (2.0, 3.2))
        self.assertEqual(cue_window(c2, 2.0, t["total_duration"]), (1.0, 7.0))
        qa = segment_qa(self.ep, t, 0.25)
        self.assertEqual(qa[0]["wer"], 0.0)
        self.assertFalse(qa[0]["flagged"])

    def test_missing_phrase_warns(self):
        t = layout(self.ep, {"seg_001": 3.0, "seg_003": 1.0})
        place_words(t, {"seg_001": [{"word": "nothing", "start": 0, "end": 0.5}]})
        warnings = place_cues(self.ep, t)
        self.assertEqual(len(warnings), 1)
        self.assertEqual(t["cues"][0]["anchor"], 1.0)

    def test_captions_srt(self):
        t = layout(self.ep, {"seg_001": 3.0, "seg_003": 1.0})
        cues = caption_cues(self.ep, t)
        self.assertEqual(cues[0][2], "The door slammed shut behind them.")
        srt = to_srt(cues)
        self.assertTrue(srt.startswith("1\n00:00:01,000 --> "))
        self.assertIn("2\n00:00:07,000 --> ", srt)


class SfxTests(unittest.TestCase):
    def test_license_filter(self):
        ok = {"license": "by", "license_version": "4.0", "url": "https://x/a.mp3", "title": "door", "tags": []}
        self.assertIsNotNone(openverse._candidate(ok))
        for bad in ("by-nc", "by-sa", "by-nd", "sampling+", "nc-sampling+"):
            self.assertIsNone(openverse._candidate({**ok, "license": bad}), bad)
        self.assertTrue(openverse._candidate(ok)["attribution_required"])
        self.assertFalse(openverse._candidate({**ok, "license": "cc0"})["attribution_required"])

    def test_rank(self):
        cue = {"query": "door slam", "exclude_tags": ["music"]}
        self.assertFalse(rank.acceptable(cue, {"title": "door slam music", "tags": []}))
        a = rank.score(cue, "door slam", {"title": "Door Slam", "tags": [], "duration_sec": 1.5})
        b = rank.score(cue, "door slam", {"title": "Door Slam", "tags": [], "duration_sec": 40})
        c = rank.score(cue, "door slam", {"title": "Door Slam", "tags": [], "duration_sec": 1.5, "attribution_required": True})
        self.assertGreater(a, b)
        self.assertGreater(a, c)
        bed = {"loop": True}
        self.assertFalse(rank.acceptable(bed, {"title": "rain", "duration_sec": 1.0}))


if __name__ == "__main__":
    unittest.main()
