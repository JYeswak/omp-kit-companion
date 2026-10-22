#!/usr/bin/env python3
"""CAPA rule pipeline for words -> enforced, proven rules."""
from __future__ import annotations
import argparse, json, re, sys
from datetime import datetime, timezone
from pathlib import Path

STATUSES = {"proposed", "specified", "building", "live", "retired"}
REQUIRED = {"id", "statement", "predicate", "cases", "control_level", "gate_refs",
            "status", "said_log_ids", "repeat_count", "owner", "metrics"}
SCHEMA_NAME = "rules.schema.json"

def now(): return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
def load(path):
    rows=[]
    for n,line in enumerate(Path(path).read_text().splitlines(),1):
        if not line.strip(): continue
        try: row=json.loads(line)
        except json.JSONDecodeError as e: raise ValueError(f"line {n}: invalid JSON: {e}")
        if not isinstance(row, dict): raise ValueError(f"line {n}: registry row must be an object")
        rows.append(row)
    return rows

def _shape_errors(r, line):
    errors=[]
    missing=sorted(REQUIRED-set(r))
    if missing: errors.append(f"line {line} {r.get('id','?')}: missing {','.join(missing)}")
    rid=r.get('id')
    for key in ("id", "statement", "predicate", "control_level", "owner"):
        if key in r and not isinstance(r[key], str): errors.append(f"line {line} {rid}: {key} must be a string")
    for key in ("gate_refs", "said_log_ids"):
        if key in r and (not isinstance(r[key], list) or any(not isinstance(v, str) for v in r[key])):
            errors.append(f"line {line} {rid}: {key} must be an array of strings")
    if "metrics" in r and not isinstance(r["metrics"], dict): errors.append(f"line {line} {rid}: metrics must be an object")
    if "cases" in r and (not isinstance(r["cases"], list) or len(r["cases"]) < 2 or
                          any(not isinstance(v, dict) or not isinstance(v.get("name"), str) for v in r["cases"])):
        errors.append(f"line {line} {rid}: cases must contain named comply and violate objects")
    if r.get("status") == "live":
        receipt = r.get("s6_receipt")
        if not isinstance(receipt, dict) or receipt.get("stage") != "S6" or not isinstance(receipt.get("window"), str) or not receipt["window"] or not isinstance(receipt.get("violation_rate"), (int, float)) or isinstance(receipt.get("violation_rate"), bool) or receipt["violation_rate"] < 0 or receipt.get("joshua_repeats") != 0:
            errors.append(f"line {line} {rid}: live rule has invalid S6 receipt")
    return errors

def _schema_path(registry):
    return Path(registry).resolve().parent / SCHEMA_NAME

def validate_schema_file(schema_path):
    try: schema=json.loads(Path(schema_path).read_text())
    except (OSError, json.JSONDecodeError) as e: raise ValueError(f"schema unavailable: {e}")
    if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema" or schema.get("type") != "object":
        raise ValueError("schema has unsupported shape")
    if set(schema.get("required", [])) != REQUIRED:
        raise ValueError("schema required fields do not match RULEPATH1 registry")

def validate(rows, receipts=None, schema_path=None):
    errs=[]; ids=set()
    if schema_path is not None: validate_schema_file(schema_path)
    receipts = ({r.get('id') for r in rows if 's6_receipt' in r}
                if receipts is None else set(receipts))
    for i,r in enumerate(rows,1):
        errs.extend(_shape_errors(r, i))
        rid=r.get('id')
        if rid in ids: errs.append(f"line {i}: duplicate id {rid}")
        ids.add(rid)
        if r.get('status') == 'live' and rid not in receipts: errs.append(f"line {i} {rid}: live rule lacks S6 receipt")
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
            if event_path:
                with Path(event_path).open('a') as stream:
                    stream.write(json.dumps(ev,sort_keys=True)+'\n')
            return ev
    raise KeyError(rid)

def prove(rows, rid, receipt):
    for r in rows:
        if r.get('id') == rid:
            if receipt.get('stage') != 'S6': raise ValueError('only S6 receipt can make a rule live')
            if not isinstance(receipt.get('window'), str) or not receipt['window'] or not isinstance(receipt.get('violation_rate'), (int, float)) or isinstance(receipt.get('violation_rate'), bool) or receipt['violation_rate'] < 0 or receipt.get('joshua_repeats') != 0:
                raise ValueError('S6 receipt requires a non-negative violation_rate, window and zero Joshua repeats')
            r['status']='live'; r['s6_receipt']=receipt; r['metrics']=dict(r.get('metrics') or {}, last_proven_at=now())
            return r
    raise KeyError(rid)

def main(argv=None):
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest='cmd',required=True)
    v=sub.add_parser('validate'); v.add_argument('registry'); v.add_argument('--receipts',default=None); v.add_argument('--schema', default=None)
    m=sub.add_parser('match'); m.add_argument('registry'); m.add_argument('utterance')
    x=sub.add_parser('repeat'); x.add_argument('registry'); x.add_argument('rule_id'); x.add_argument('--events')
    p=sub.add_parser('prove'); p.add_argument('registry'); p.add_argument('rule_id'); p.add_argument('receipt')
    args=ap.parse_args(argv)
    try:
        rows=load(args.registry)
        if args.cmd=='validate':
            schema = args.schema or _schema_path(args.registry)
            receipts = None
            if args.receipts:
                receipts = {str(row.get("rule_id", row.get("id"))) for row in load(args.receipts)}
            errs=validate(rows,receipts,schema); print(json.dumps({'ok':not errs,'errors':errs},sort_keys=True)); return 0 if not errs else 1
        if args.cmd=='match': print(json.dumps({'matches':match(rows,args.utterance)})); return 0
        if args.cmd=='repeat': ev=repeat(rows,args.rule_id,args.events); save(args.registry,rows); print(json.dumps(ev,sort_keys=True)); return 0
        rec=json.loads(Path(args.receipt).read_text()); prove(rows,args.rule_id,rec); save(args.registry,rows); print(json.dumps({'ok':True,'rule_id':args.rule_id})); return 0
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as e: print(f"ERROR: {e}",file=sys.stderr); return 2
if __name__=='__main__': raise SystemExit(main())
