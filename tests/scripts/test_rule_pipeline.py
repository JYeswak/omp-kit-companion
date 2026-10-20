import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parents[2] / 'scripts'))
import rule_pipeline as rp

class RulePipelineTest(unittest.TestCase):
    def rule(self, status='building'):
        return {'id':'R-WAVE','statement':'dispatch waves of independent beads','predicate':'two claimable beads and no background agent violates','cases':[{'name':'comply'},{'name':'violate'}],'control_level':'L2','gate_refs':['G-WAVE'],'status':status,'said_log_ids':['J-1'],'repeat_count':0,'owner':'director','metrics':{}}
    def test_live_without_receipt_fails(self):
        self.assertTrue(any('S6 receipt' in e for e in rp.validate([self.rule('live')])))
    def test_repeat_raises_p0_and_andon(self):
        rows=[self.rule()]; event=rp.repeat(rows,'R-WAVE')
        self.assertEqual(rows[0]['repeat_count'],1); self.assertEqual(rows[0]['enforcement_priority'],'P0')
        self.assertTrue(rows[0]['andon']); self.assertEqual(event['page'],['lead','director'])
    def test_six_receipt_is_required_and_makes_live(self):
        rows=[self.rule()]
        with self.assertRaises(ValueError): rp.prove(rows,'R-WAVE',{'stage':'S5'})
        rp.prove(rows,'R-WAVE',{'stage':'S6','window':'7d','violation_rate':0.0,'joshua_repeats':0})
        self.assertEqual(rows[0]['status'],'live'); self.assertFalse(rp.validate(rows))
    def test_match_excludes_retired_and_finds_wave(self):
        rows=[self.rule(), dict(self.rule(),id='R-OLD',status='retired')]
        self.assertEqual(rp.match(rows,'dispatch waves of independent beads'),['R-WAVE'])

if __name__ == '__main__': unittest.main()
