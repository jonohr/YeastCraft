#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Read-only, streaming field parity check for a legacy CSV import."""
import argparse,csv,json,math,sqlite3
from pathlib import Path
from datetime import datetime,timezone
p=argparse.ArgumentParser();p.add_argument('--data',type=Path,required=True);p.add_argument('--database',type=Path,required=True);a=p.parse_args()
c=sqlite3.connect(f'file:{a.database}?mode=ro',uri=True);checked=fields=0
for f in sorted(a.data.glob('*.csv')):
 if f.name.endswith('_graph.csv') and f.with_name(f.name.replace('_graph.csv','_full.csv')).exists():continue
 if not f.name.endswith(('_graph.csv','_full.csv')):continue
 gravity=f.name.startswith('Gravity Device ');marker=' - L' if gravity else ' - B';id=int(f.name.split(marker)[1].split(' - ')[0]);source=f"legacy:{'gravity_gravitylog' if gravity else 'app_beer'}:{id}"
 cursor=c.execute('SELECT time,values_json FROM points WHERE source=? ORDER BY sequence',(source,))
 with f.open(newline='') as stream:
  for row in csv.DictReader(stream):
   point=cursor.fetchone();assert point is not None,'Missing destination row';time,raw=point;values=json.loads(raw)
   stamp=int(datetime.strptime(row['log_time'],'%Y/%m/%d %H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp()*1000);assert time==stamp,'Timestamp mismatch'
   for k,v in row.items():
    if k=='log_time':continue
    if v in ('','None','null'):expected=None
    elif v in ('True','False'):expected=v=='True'
    elif k in ('beer_ann','fridge_ann','extra_data','temp_format','log_id','associated_beer_id'):expected=v
    else:expected=float(v)
    actual=values.get(k)
    if isinstance(expected,float):assert isinstance(actual,(int,float)) and math.isclose(expected,actual,rel_tol=1e-12,abs_tol=1e-12),f'Numeric mismatch: {k}'
    else:assert actual==expected,f'Field mismatch: {k}'
    fields+=1
   checked+=1
 assert cursor.fetchone() is None,'Unexpected extra destination row'
assert c.execute('SELECT COUNT(*) FROM points').fetchone()[0]==checked,'Total row mismatch'
print(json.dumps({'rows_checked':checked,'fields_checked':fields,'result':'exact timestamps/text/booleans; numeric tolerance 1e-12'}))
