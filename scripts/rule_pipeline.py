#!/usr/bin/env python3
"""CAPA rule pipeline for words -> enforced, proven rules."""
from __future__ import annotations
import argparse, json, re, sys
from datetime import datetime, timezone
from pathlib import Path

STATUSES = {"proposed", "specified", "building", "live", "retired"}
REQUIRED = {"id", "statement", "predicate", "cases", "control_level", "gate_refs", "status", "said_log_ids", "repeat_count", "owner", "metrics"}

def now(): return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
def load(path):
    rows=[]
    for n,line in enumerate(Path(path).read_text().splitlines(),1):
        if not line.strip(): continue
        try: row=json.loads(line)
        except json.JSONDecodeError as e: raise ValueError(f"line {n}: invalid JSON: {e}")
        rows.append(row)
    return rows

def validate(rows, receipts=None):
    errs=[]; ids=set()
    receipts = ({r.get('id') for r in rows if 's6_receipt' in r}
                if receipts is None else set(receipts))
    for i,r in enumerate(rows,1):
        missing=sorted(REQUIRED-set(r))
        if missing: errs.append(f"line {i} {r.get('id','?')}: missing {','.join(missing)}")
        rid=r.get('id')
        if rid in ids: errs.append(f"line {i}: duplicate id {rid}")
        ids.add(rid)
        if r.get('status') not in STATUSES: errs.append(f"line {i} {rid}: invalid status")
        if not isinstance(r.get('cases'), list) or len(r.get('cases',[])) < 2: errs.append(f"line {i} {rid}: cases must contain comply and violate")
        if r.get('status') == 'live' and rid not in receipts: errs.append(f"line {i} {rid}: live rule lacks S6 receipt")
        if int(r.get('repeat_count',0)) < 0: errs.append(f"line {i} {rid}: negative repeat_count")
    return errs

def save(path, rows):
    p=Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(''.join(json.dumps(r, sort_keys=True, separators=(',', ':'))+'\n' for r in rows))

def tokens(s):
    return set(re.findall(r"[a-z0-9][a-z0-9_-]{2,}", str(s)[:1_048_576].lower()))
def match(rows, utterance):
    q=tokens(utterance); out=[]
    for r in rows:
        if r.get('status') == 'retired': continue
        hay=tokens(' '.join(str(r.get(k,'')) for k in ('title','statement','predicate')))
        score=len(q & hay) / max(1, len(q))
        if score >= .25: out.append((score, r['id']))
    return [rid for _,rid in sorted(out, reverse=True)]

def repeat(rows, rid, event_path=None):
    for r in rows:
        if r.get('id') == rid:
            r['repeat_count']=int(r.get('repeat_count',0))+1
            r['last_repeat_at']=now(); r['status']='building' if r.get('status') == 'live' else r.get('status','proposed')
            r['enforcement_priority']='P0'; r['andon']=True
            ev={'type':'repeat_andon','rule_id':rid,'priority':'P0','page':['lead','director'],'at':r['last_repeat_at']}
            if event_path: Path(event_path).open('a').write(json.dumps(ev,sort_keys=True)+'\n')
            return ev
    raise KeyError(rid)

def prove(rows, rid, receipt):
    for r in rows:
        if r.get('id') == rid:
            if receipt.get('stage') != 'S6': raise ValueError('only S6 receipt can make a rule live')
            if receipt.get('violation_rate') is None or receipt.get('window') is None or receipt.get('joshua_repeats') != 0: raise ValueError('S6 receipt requires window, violation_rate and zero Joshua repeats')
            r['status']='live'; r['s6_receipt']=receipt; r['metrics']=dict(r.get('metrics') or {}, last_proven_at=now())
            return r
    raise KeyError(rid)

def main(argv=None):
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest='cmd',required=True)
    v=sub.add_parser('validate'); v.add_argument('registry'); v.add_argument('--receipts',default=None)
    m=sub.add_parser('match'); m.add_argument('registry'); m.add_argument('utterance')
    x=sub.add_parser('repeat'); x.add_argument('registry'); x.add_argument('rule_id'); x.add_argument('--events')
    p=sub.add_parser('prove'); p.add_argument('registry'); p.add_argument('rule_id'); p.add_argument('receipt')
    args=ap.parse_args(argv)
    try:
        rows=load(args.registry)
        if args.cmd=='validate':
            receipts=set(load(args.receipts)) if args.receipts else {r['id'] for r in rows if 's6_receipt' in r}
            errs=validate(rows,receipts); print(json.dumps({'ok':not errs,'errors':errs},sort_keys=True)); return 0 if not errs else 1
        if args.cmd=='match': print(json.dumps({'matches':match(rows,args.utterance)})); return 0
        if args.cmd=='repeat': ev=repeat(rows,args.rule_id,args.events); save(args.registry,rows); print(json.dumps(ev,sort_keys=True)); return 0
        rec=json.loads(Path(args.receipt).read_text()); prove(rows,args.rule_id,rec); save(args.registry,rows); print(json.dumps({'ok':True,'rule_id':args.rule_id})); return 0
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as e: print(f"ERROR: {e}",file=sys.stderr); return 2
if __name__=='__main__': raise SystemExit(main())
