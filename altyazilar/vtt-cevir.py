"""YouTube otomatik altyazi (VTT) -> tekrar temizlenmis SRT + duz metin.

Kullanim: python vtt-cevir.py cleric-build.tr.vtt cleric-build.tr
"""
import re
import sys
from pathlib import Path


def temizle(satir: str) -> str:
    satir = re.sub(r"<[^>]+>", "", satir)
    satir = satir.replace("&nbsp;", " ").replace("&amp;", "&")
    satir = satir.replace("&lt;", "<").replace("&gt;", ">").replace("&#39;", "'")
    return satir.strip()


def kelimeler(metin: str):
    return [k for k in metin.split() if k]


def ortak_kuyruk(onceki, yeni):
    """onceki'nin sonu ile yeni'nin basi arasindaki en uzun ortaklik."""
    en = min(len(onceki), len(yeni))
    for n in range(en, 0, -1):
        if onceki[-n:] == yeni[:n]:
            return n
    return 0


def main():
    kaynak = Path(sys.argv[1])
    hedef = Path(sys.argv[2])

    cues = []
    for blok in re.split(r"\n\s*\n", kaynak.read_text(encoding="utf-8")):
        satirlar = blok.strip().splitlines()
        if not satirlar:
            continue
        zaman = next((s for s in satirlar if "-->" in s), None)
        if not zaman:
            continue
        bas, son = [t.strip().split(" ")[0] for t in zaman.split("-->")[:2]]
        metin_satirlari = satirlar[satirlar.index(next(s for s in satirlar if "-->" in s)) + 1:]
        metin = temizle(" ".join(metin_satirlari))
        if metin:
            cues.append((bas, son, metin))

    # yt-dlp otomatik altyazisi kayan metin: her cue oncekinin devami.
    srt = []
    onceki_kelime = []
    for bas, son, metin in cues:
        k = kelimeler(metin)
        n = ortak_kuyruk(onceki_kelime, k)
        yeni = k[n:]
        if yeni:
            srt.append((bas, son, " ".join(yeni)))
        onceki_kelime = k

    def srt_zaman(t: str) -> str:
        t = t.replace(".", ",")
        parca = t.split(":")
        if len(parca) == 2:
            t = "00:" + t
        return t

    srt_metni = []
    for i, (bas, son, metin) in enumerate(srt, 1):
        srt_metni.append(f"{i}\n{srt_zaman(bas)} --> {srt_zaman(son)}\n{metin}\n")
    srt_yolu = Path(str(hedef) + ".srt")
    srt_yolu.write_text("\n".join(srt_metni), encoding="utf-8")

    # Duz metin: cumle sonlarinda paragraf kir, satir basina bosluk yok.
    akis = " ".join(m for _, _, m in srt)
    akis = re.sub(r"\s+", " ", akis).strip()
    parcalar = re.split(r"(?<=[.!?])\s+", akis)
    satirlar, tampon = [], ""
    for p in parcalar:
        tampon = (tampon + " " + p).strip()
        if len(tampon) > 700:
            satirlar.append(tampon)
            tampon = ""
    if tampon:
        satirlar.append(tampon)
    (hedef.with_suffix(".txt")).write_text("\n\n".join(satirlar) + "\n", encoding="utf-8")

    print(f"{len(srt)} cue yazildi -> {hedef.with_suffix('.srt')}, {hedef.with_suffix('.txt')}")


if __name__ == "__main__":
    main()
