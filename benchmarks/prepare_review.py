"""Build a human listening checklist from private Gate 0 ASR outputs."""

import json
from pathlib import Path


BASE = Path(__file__).parent / "private"
FILLER_PHRASES = ("嗯", "呃", "啊", "那个", "这个", "就是", "然后")


def mmss(seconds: float) -> str:
    return f"{int(seconds // 60):02}:{seconds % 60:04.1f}"


def candidate_repeats(text: str, times: list[float]) -> list[str]:
    items = []
    occupied = -1
    for pos in range(len(text)):
        if pos < occupied:
            continue
        for width in range(8, 1, -1):
            if text[pos:pos + width] and text[pos:pos + width] == text[pos + width:pos + 2 * width]:
                items.append(f"{mmss(times[pos])} `{text[pos:pos + 2 * width]}`")
                occupied = pos + 2 * width
                break
    return items


parts = [
    "# Gate 0｜六段录音人工核对表",
    "",
    "请听原录音。可以先把每段「机器转录草稿」复制到「真实逐字稿」，再逐处修正，不必从零打字。保留‘嗯、呃、啊’、重复、改口、病句；不要为了通顺而润色。听不清的地方写 `[听不清 00:00]`。专有名词按实际说法写，拿不准可标 `[待确认]`。",
    "",
    "然后核对下方机器候选：实际说了但机器漏掉的填充词或重复，请补上大约时间；机器写了但实际没说的，请划掉或注明。`那个/这个/就是/然后` 只有用作口头填充时才标为填充词，正常指代或连接不用标。静音候选只需判断是否真有停顿，以及是正常思考、句间停顿、句中卡顿，还是录音操作/环境造成。时间允许有约 0.5 秒误差。",
    "",
    "目前只需核对这六段。保存后告诉我，我会据此计算事件级召回率、精确率和 F1，并列出误报/漏报样例。",
]

for i in range(1, 7):
    name = f"sample-{i:03}"
    data = json.loads((BASE / f"{name}-sherpa.json").read_text(encoding="utf-8"))
    silence = json.loads((BASE / f"{name}-silence.json").read_text(encoding="utf-8"))
    token = data["token_result"]
    text = token["text"]
    times = token["timestamps"]
    filler_candidates = []
    for phrase in FILLER_PHRASES:
        start = 0
        while (pos := text.find(phrase, start)) >= 0:
            filler_candidates.append((times[pos], phrase))
            start = pos + len(phrase)
    filler_candidates.sort()
    repeats = candidate_repeats(text, times)
    silences = [f"{mmss(e['start_s'])}–{mmss(e['end_s'])} ({e['duration_s']:.1f} 秒)" for e in silence["events"]]

    parts += [
        "", f"## {name}｜{data['duration_s']:.1f} 秒", "",
        f"[播放录音]({name}.m4a)", "",
        "**机器转录草稿（可能有错）**", "", text, "",
        "**真实逐字稿（请填写）**", "", "<!-- 在此写下听到的原话，保留填充词和重复。 -->", "",
        "**机器识别出的填充词候选（请确认用途和时间；补充漏掉的）**", "",
        ", ".join(f"{mmss(t)} `{phrase}`" for t, phrase in filler_candidates) or "无", "",
        "漏掉 / 误报 / 正常词义：", "", "",
        "**机器文本中的相邻重复候选（请确认，并补充漏掉的）**", "",
        ", ".join(repeats) or "无", "",
        "漏掉 / 误报：", "", "",
        "**音量阈值检测到的 ≥1 秒静音候选（请标注语境）**", "",
        ", ".join(silences) or "无", "",
        "实际停顿、语境和其他遗漏：", "", "",
    ]

(BASE / "manual-review.md").write_text("\n".join(parts), encoding="utf-8")
print(BASE / "manual-review.md")
