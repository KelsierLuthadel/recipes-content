#!/usr/bin/env python
"""One-shot: insert ## Overview sections into the 18 cuisine/indian/Meals/
recipes that were missing them. Inserts the new section immediately
before the first `## Ingredients` heading. Idempotent: skips any file
that already has a `## Overview` heading."""

from pathlib import Path
import re
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent

OVERVIEWS = {
    'butter-chicken.md': (
        "The BIR icon: tandoori-grilled chicken finished in a velvety tomato-onion sauce "
        "enriched with double cream, butter and a hit of garam masala at the end. Mildly "
        "spiced, lightly sweet, deeply savoury. The sauce is built on a paste of cooked onion, "
        "tomato and cashews / almonds, finished off-heat with cold butter for the signature gloss."
    ),
    'chicken-balti.md': (
        "Birmingham's defining curry, cooked hard and fast in a thin two-handled steel balti "
        "pan over a roaring flame. The high heat caramelises the masala onto the meat and burns "
        "off the oil, leaving a slightly smoky, tomato-forward sauce. Eaten straight from the "
        "pan with naan; the sauce is medium-thick, not soupy."
    ),
    'chicken-ceylon.md': (
        "A British curry-house classic loosely inspired by Sri Lankan flavours: a coconut-and-"
        "lemon sauce with mustard seeds, curry leaves and a touch of green chilli. Sharp from "
        "the lemon, sweet from the coconut, mildly hot. Distinguished from a korma by the "
        "lemony brightness and from a Goan curry by the lack of vinegar."
    ),
    'chicken-chasni.md': (
        "The Glaswegian curry-house favourite: a pink-orange sweet-and-savoury sauce built on "
        "tomato puree, mango chutney, yogurt and double cream. Mild, sweet, faintly tangy. "
        "Not authentic to any subcontinental region, but a defining BIR plate in Scotland."
    ),
    'chicken-chilli-garlic.md': (
        "A garlic-forward BIR cooked hot and fast: pre-cooked chicken finished in a base sauce "
        "loaded with chopped garlic and fresh green chillies, with tomatoes, peppers and a "
        "tablespoon of vinegar to balance. Aromatic, sharp, fiery; eat with rice to tame it."
    ),
    'chicken-dhansak.md': (
        "The British-Indian adaptation of the Parsi original: chicken simmered in a yellow "
        "split-pea (toor dal) sauce that's both sweet (from pineapple chunks or jaggery) and "
        "sour (from tamarind and lemon). Thick, hearty, distinctive. The dhansak signature is "
        "the lentil body plus the sweet/sour balance."
    ),
    'chicken-jalfrezi.md': (
        "A quick stir-fried curry with crunchy bell peppers, onion wedges and fresh tomato "
        "around tender chicken in a tomato-and-chilli sauce. Medium-hot, dry-ish (no cream), "
        "with the vegetables retaining bite. The dish that was invented to use up leftover "
        "Sunday roast meat with fresh aromatics."
    ),
    'chicken-korma.md': (
        "The mildest of the classic BIR curries: a pale, gently spiced sauce of cooked onion, "
        "cream, ground almonds (or cashews) and a touch of coconut. Cardamom and cinnamon "
        "provide warmth without heat. The dish ordered when the table includes a child or "
        "anyone who shies from chilli."
    ),
    'chicken-pasanda.md': (
        "A mild, creamy curry built around flattened, tenderised chicken (the meat-mallet step "
        "is what makes it pasanda) in a yogurt-and-almond sauce finished with cream. Gently "
        "spiced with cardamom and mace; faintly sweet. A Mughal-court dish in origin, "
        "domesticated in the BIR canon."
    ),
    'chicken-pathia.md': (
        "BIR hot-sweet-sour: a medium-hot curry sweetened with sugar (or jaggery) and "
        "sharpened with tamarind and lemon juice. Tomato-forward, chilli-warm, with the "
        "sweet-sour balance the defining note. A standard order alongside dhansak in the "
        "sweet-and-sour family of curry-house dishes."
    ),
    'dopiaza.md': (
        "Two-onion curry: half the onions are blended into the base sauce for sweetness and "
        "body, the other half added late as chunky wedges to retain bite and texture. The "
        "result is an onion-double-act curry, medium-spiced, deeply savoury. Lamb or chicken "
        "both work; the method is what makes a dopiaza, not the protein."
    ),
    'lamb-bhuna.md': (
        "Bhuna means \"fried\" or \"sauteed\"; the dish is dry-style, with the sauce cooked "
        "right down onto the meat. Lamb pieces simmer in a deeply reduced tomato-onion-and-"
        "spice paste until the oil rises and the masala clings tight. Concentrated, medium-"
        "hot, no wateriness."
    ),
    'lamb-bhuna2.md': (
        "An alternative take on bhuna: same dry-style, masala-on-the-meat finish, but built on "
        "whole spices toasted in hot oil before the meat goes in. The whole-spice toasting "
        "perfumes the oil and gives a slightly different aromatic profile from the first "
        "bhuna recipe. Both end with the masala coating each piece of meat."
    ),
    'lamb-karahi.md': (
        "Cooked in a karahi (two-handled wok-like pan) over high heat: lamb chunks simmer "
        "with tomatoes, fresh ginger matchsticks and green chillies, with cracked black "
        "pepper and ground cumin going in late. No onion in the sauce. Punjabi origin, "
        "fiercely fresh-tasting, the antithesis of long-cooked British curry-house style."
    ),
    'lamb-madrass.md': (
        "Hot, sharp curry inspired by the cooking of southern India. Reduced tomato base with "
        "a heavy dose of chilli powder, mustard seeds, curry leaves and tamarind. Sharper "
        "than a vindaloo (no vinegar) but in the same heat range; finished with lime juice "
        "and a spoon of mango chutney for sweet contrast."
    ),
    'lamb-nihari.md': (
        "The Mughal-Pakistani slow-cooked lamb shank stew: meat braised for hours in a "
        "spice-thick gravy of ginger, garlic, ground spices and a wheat-flour slurry that "
        "gives the broth its characteristic velvety body. Traditionally a Friday-morning "
        "dish in Lahore. Mild compared to other curries; the flavour is deep rather than hot."
    ),
    'lamb-rogan-josh.md': (
        "Kashmir's signature red lamb curry: the colour comes from Kashmiri chillies and "
        "ratan jot (alkanet root) rather than tomato. Lamb braises slowly in yogurt with "
        "asafoetida, fennel, ginger and ground spices until the gravy is silky and the meat "
        "fork-tender. Medium heat, deeply aromatic, a celebration dish."
    ),
    'vindaloo.md': (
        "The fiery Goan original: a vinegar-and-garlic-marinated meat (traditionally pork, "
        "adapted in BIR menus to chicken or lamb) simmered in a dark masala loaded with red "
        "chillies, cumin and mustard seeds. The sharp acidity from vinegar plus aggressive "
        "chilli is the signature; potatoes are a BIR addition (the \"aloo\" suggestion) but "
        "not part of the Portuguese-origin dish."
    ),
}


def insert_overview(path: Path, overview: str) -> str:
    text = path.read_text(encoding='utf-8')
    if re.search(r'^##\s+Overview\b', text, flags=re.M):
        return 'skipped (already has overview)'
    # Insert before the first ## Ingredients heading.
    new_section = f"## Overview\n{overview}\n\n"
    pattern = re.compile(r'(^##\s+Ingredients\b)', flags=re.M)
    if not pattern.search(text):
        return 'skipped (no ## Ingredients heading)'
    new_text = pattern.sub(new_section + r'\1', text, count=1)
    path.write_text(new_text, encoding='utf-8')
    return 'inserted'


def main():
    base = REPO_ROOT / 'cuisine' / 'indian' / 'Meals'
    for fname, overview in OVERVIEWS.items():
        p = base / fname
        if not p.exists():
            print(f"missing: {p}")
            continue
        status = insert_overview(p, overview)
        print(f"{status}: {fname}")


if __name__ == '__main__':
    main()
