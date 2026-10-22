import unittest
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parents[2] / 'scripts'))
import rule_pipeline as rp
from kitlib_tmp import owned_tmp  # noqa: E402  (kitlib owned temp dirs: removed on exit and on HUP/INT/TERM)

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

    def test_live_receipt_must_be_well_formed(self):
        row = self.rule('live')
        row['s6_receipt'] = {'stage': 'S6', 'window': '7d', 'violation_rate': -1, 'joshua_repeats': 0}
        self.assertTrue(any('invalid S6 receipt' in e for e in rp.validate([row])))

    def test_repeat_reopens_live_rule_and_writes_andon_event(self):
        rows = [self.rule('live')]
        rows[0]['s6_receipt'] = {'stage': 'S6', 'window': '7d', 'violation_rate': 0, 'joshua_repeats': 0}
        with owned_tmp("rule-pipeline-test") as directory:
            event = Path(directory) / 'events.jsonl'
            result = rp.repeat(rows, 'R-WAVE', event)
            self.assertEqual(rows[0]['status'], 'building')
            self.assertEqual(json.loads(event.read_text())['rule_id'], 'R-WAVE')
            self.assertEqual(result['priority'], 'P0')

    def test_registry_schema_is_present_and_required_fields_are_checked(self):
        root = Path(__file__).parents[2]
        registry = rp.load(root / 'policy' / 'rules.jsonl')
        self.assertFalse(rp.validate(registry, schema_path=root / 'policy' / 'rules.schema.json'))
        broken = dict(self.rule())
        del broken['predicate']
        self.assertTrue(any('missing predicate' in e for e in rp.validate([broken])))

if __name__ == '__main__': unittest.main()
