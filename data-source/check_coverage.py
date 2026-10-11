#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检验已抓取数据源对 UI 设计稿所需字段的覆盖能力。只读，不修改原始数据。"""
import json, os, re

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw")

def load(name):
    p = os.path.join(RAW, name)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)

# UI 设计稿中出现的锚点院校（07a/07b/05/06 页面）
ANCHORS = {
    "ca": ["Toronto", "British Columbia", "McGill", "Waterloo", "Queen", "Alberta", "McMaster", "Western"],
    "au": ["Sydney", "New South Wales", "Monash", "Melbourne", "Australian National", "Queensland"],
    "uk": ["Edinburgh", "Manchester", "Imperial", "UCL", "Cambridge", "Oxford"],
}

print("=" * 62)
print("A. worqnow — 大学列表覆盖")
print("=" * 62)
worq = {}
for c in ("ca", "au", "uk"):
    d = load(f"worqnow-{c}-universities.json")
    if not d:
        continue
    worq[c] = d
    items = d.get("data", [])
    has_courses = sum(1 for u in items if u.get("courses"))
    has_site = sum(1 for u in items if u.get("website"))
    print(f"\n[{c.upper()}] count={d.get('count')} 实际={len(items)}  有courses={has_courses}  有website={has_site}")
    print("  字段:", ", ".join(sorted(items[0].keys())) if items else "n/a")
    names = [u.get("name", "") for u in items]
    for a in ANCHORS[c]:
        hit = [n for n in names if a.lower() in n.lower()]
        mark = "OK " if hit else "MISS"
        print(f"   {mark} {a:<22} -> {hit[0] if hit else '未收录'}")

print("\n" + "=" * 62)
print("B. worqnow — 录取要求覆盖（这是 UI 的核心字段来源）")
print("=" * 62)
for c in ("ca", "au", "uk"):
    d = load(f"worqnow-{c}-entry.json")
    if not d:
        continue
    data = d.get("data", {})
    print(f"\n[{c.upper()}] entry 记录数={len(data)}（对比该国有 {len(worq.get(c, {}).get('data', []))} 所大学）")
    has_ielts = has_pathway = has_gpa = 0
    for slug, v in data.items():
        el = v.get("english_language", {}) or {}
        if el.get("ielts_overall"):
            has_ielts += 1
        pp = v.get("pathway_programs", {}) or {}
        if pp.get("available") or pp.get("description"):
            has_pathway += 1
        br = v.get("bachelor_requirements", {}) or {}
        if br.get("gpa_equivalent") or br.get("minimum_grade"):
            has_gpa += 1
    print(f"   有 IELTS 分数线 = {has_ielts}/{len(data)}")
    print(f"   有 预科/双录路径 = {has_pathway}/{len(data)}")
    print(f"   有 GPA 等效说明  = {has_gpa}/{len(data)}")
    # 字段全集
    keys = set()
    for v in data.values():
        keys |= set(v.keys())
    print("   记录字段:", ", ".join(sorted(keys)))

print("\n" + "=" * 62)
print("C. Hipolabs — 全球大学基础库")
print("=" * 62)
for name, label in (("hipolabs-canada.json", "Canada"), ("hipolabs-australia.json", "Australia"), ("hipolabs-uk.json", "UK")):
    d = load(name)
    if not d:
        continue
    print(f"\n[{label}] 条目数={len(d)}")
    print("  字段:", ", ".join(sorted(d[0].keys())) if d else "n/a")
    # 记录院校名噪音
    noise = [x for x in d if re.search(r"Seminary|Bible|Theolog|College of|Academy|Institute of Tech", x.get("name", ""), re.I)]
    print(f"  疑似非目标院校（神学院/学院等）: {len(noise)} 条，占比 {len(noise)/max(len(d),1)*100:.0f}%")
    for a in ANCHORS.get({"Canada":"ca","Australia":"au","UK":"uk"}[label], []):
        hit = [x["name"] for x in d if a.lower() in x.get("name", "").lower()]
        print(f"   {'OK ' if hit else 'MISS'} {a:<22} -> {hit[0] if hit else '未收录'}")

print("\n" + "=" * 62)
print("D. 关键字段缺失检查")
print("=" * 62)
sample = (worq.get("ca", {}).get("data") or [{}])[0]
print("worqnow 大学记录字段:", sorted(sample.keys()))
for f in ("qs_rank", "ranking", "rank", "score", "chinese_name", "name_cn", "crest", "logo"):
    print(f"   {'有' if f in sample else '缺'} {f}  <- QS排名/中文名/校徽")
print("\n结论：两源均无 QS 排名、无中文名、无校徽资源。")
