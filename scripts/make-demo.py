#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Generate synthetic legacy fixtures. Never reads production data."""
from pathlib import Path
import sqlite3, csv, math, argparse
from datetime import datetime, timedelta, timezone
parser=argparse.ArgumentParser();parser.add_argument('destination',type=Path);args=parser.parse_args();root=args.destination
root.mkdir(parents=True,exist_ok=True);data=root/'data';data.mkdir(exist_ok=True)
if (root/'source.sqlite').exists():raise SystemExit('Refusing to replace an existing source.sqlite')
c=sqlite3.connect(root/'source.sqlite');c.executescript("""
CREATE TABLE app_brewpidevice(id INTEGER PRIMARY KEY,device_name TEXT,temp_format TEXT,wifi_host TEXT,wifi_port INTEGER,connection_type TEXT);
INSERT INTO app_brewpidevice VALUES(1,'Demo chamber','C','brewpi.example.invalid',23,'wifi');
CREATE TABLE app_beer(id INTEGER PRIMARY KEY,name TEXT,device_id INTEGER,format TEXT,created TEXT);
INSERT INTO app_beer VALUES(1,'Demo pale ale',1,'C','2026-11-01T10:00:00Z');
CREATE TABLE gravity_gravitysensor(id INTEGER PRIMARY KEY,name TEXT,sensor_type TEXT,temp_format TEXT);
INSERT INTO gravity_gravitysensor VALUES(1,'Demo manual sensor','manual','C');
CREATE TABLE app_fermentationprofile(id INTEGER PRIMARY KEY,name TEXT);
INSERT INTO app_fermentationprofile VALUES(1,'Demo ale');
CREATE TABLE app_fermentationprofilepoint(id INTEGER PRIMARY KEY,profile_id INTEGER,ttl INTEGER,temperature_setting REAL,temp_format TEXT);
INSERT INTO app_fermentationprofilepoint VALUES(1,1,0,18,'C');
INSERT INTO app_fermentationprofilepoint VALUES(2,1,86400000000,20,'C');
""");c.commit();c.close()
with (data/'Device 1 - B1 - Demo pale ale_full.csv').open('w',newline='') as f:
 w=csv.writer(f);w.writerow(['log_time','beer_temp','beer_set','beer_ann','fridge_temp','fridge_set','fridge_ann','room_temp','state','temp_format','associated_beer_id','gravity','grav_temp'])
 for i in range(289):
  t=datetime(2026,11,1,10,tzinfo=timezone.utc)+timedelta(minutes=30*i)
  w.writerow([t.strftime('%Y/%m/%d %H:%M:%SZ'),round(18+.2*math.sin(i/10),3),18,'Demo note' if i==100 else '',round(17.5+.4*math.sin(i/10),3),18,'',21,0,'C',1,round(1.055-.035*i/288,4),18])
print('Synthetic fixture created:',root)
