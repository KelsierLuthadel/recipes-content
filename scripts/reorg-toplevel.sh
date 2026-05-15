#!/bin/bash
# Move top-level cuisine-attributed recipes into their cuisine/<x>/ subfolders.
# Each move: .md, the source image, the thumb. Uses git mv for tracked files.
set -e
cd "$(dirname "$0")/.."

# Map of "source .md path" -> "target .md path".
declare -A MOVES=(
  # appetitizer/
  ["appetitizer/baked-borek.md"]="cuisine/turkish/snacks/baked-borek.md"
  ["appetitizer/fried-borek.md"]="cuisine/turkish/snacks/fried-borek.md"
  ["appetitizer/cheese-straws.md"]="cuisine/british/snacks/cheese-straws.md"
  ["appetitizer/parma-ham-mikados.md"]="cuisine/italian/snacks/parma-ham-mikados.md"
  ["appetitizer/tahina-dip.md"]="cuisine/middle-east/side-dishes/tahina-dip.md"
  # breakfast/
  ["breakfast/eggs-benedict.md"]="cuisine/american/eggs-benedict.md"
  ["breakfast/buttermilk-pancakes.md"]="cuisine/american/buttermilk-pancakes.md"
  ["breakfast/croque-monsieur.md"]="cuisine/french/snacks/croque-monsieur.md"
  ["breakfast/frittata.md"]="cuisine/italian/frittata.md"
  # pies/
  ["pies/meat-pies/lamb-pasties.md"]="cuisine/british/snacks/lamb-pasties.md"
  ["pies/sweet-pies/mince-pies.md"]="cuisine/british/desserts/mince-pies.md"
  # salad/
  ["salad/cajun-salad.md"]="cuisine/cajun/side-dishes/cajun-salad.md"
  ["salad/thai-cucumber-salad.md"]="cuisine/thai/side-dishes/thai-cucumber-salad.md"
  # sides/
  ["sides/asparagus-prosciutto.md"]="cuisine/italian/side-dishes/asparagus-prosciutto.md"
  ["sides/bombay-potato.md"]="cuisine/indian/side-dishes/bombay-potato.md"
  ["sides/boulangere-potato.md"]="cuisine/french/side-dishes/boulangere-potato.md"
  ["sides/celariac-and-dauphinoise.md"]="cuisine/french/side-dishes/celariac-and-dauphinoise.md"
  ["sides/ceviche.md"]="cuisine/south-american/ceviche.md"
  ["sides/chilli-red-onion-raita.md"]="cuisine/indian/side-dishes/chilli-red-onion-raita.md"
  ["sides/fried-wuntun.md"]="cuisine/chinese/snacks/fried-wuntun.md"
  ["sides/herb-crepes.md"]="cuisine/french/side-dishes/herb-crepes.md"
  ["sides/marbled-tea-egg.md"]="cuisine/chinese/side-dishes/marbled-tea-egg.md"
  ["sides/onion-bahjis.md"]="cuisine/indian/snacks/onion-bahjis.md"
  ["sides/spiced-chinese-leaves.md"]="cuisine/chinese/side-dishes/spiced-chinese-leaves.md"
  ["sides/spring-rolls.md"]="cuisine/chinese/snacks/spring-rolls.md"
  ["sides/stir-fried-ginger-broccoli.md"]="cuisine/chinese/side-dishes/stir-fried-ginger-broccoli.md"
  ["sides/stir-fried-mange-tout.md"]="cuisine/chinese/side-dishes/stir-fried-mange-tout.md"
  ["sides/stir-fried-spinach.md"]="cuisine/chinese/side-dishes/stir-fried-spinach.md"
  ["sides/wok-fried-greens.md"]="cuisine/chinese/side-dishes/wok-fried-greens.md"
  # snacks/
  ["snacks/guacamole.md"]="cuisine/mexican/snacks/guacamole.md"
  ["snacks/sausage-rolls.md"]="cuisine/british/snacks/sausage-rolls.md"
  ["snacks/scotch-eggs.md"]="cuisine/british/snacks/scotch-eggs.md"
  ["snacks/tzatziki.md"]="cuisine/greek/side-dishes/tzatziki.md"
  # soup/
  ["soup/beef-pho.md"]="cuisine/vietnamese/beef-pho.md"
  ["soup/caribbean-fish-soup.md"]="cuisine/jamaican/caribbean-fish-soup.md"
  ["soup/manhattan-seafood-chowder.md"]="cuisine/american/manhattan-seafood-chowder.md"
  ["soup/mexican-soup.md"]="cuisine/mexican/mexican-soup.md"
  ["soup/mulligatawny.md"]="cuisine/indian/Meals/mulligatawny.md"
  ["soup/new-england-clam-chowder.md"]="cuisine/american/new-england-clam-chowder.md"
  ["soup/tortilla-soup.md"]="cuisine/mexican/tortilla-soup.md"
  ["soup/vietnamese-beef-soup.md"]="cuisine/vietnamese/vietnamese-beef-soup.md"
  ["soup/wuntun-soup.md"]="cuisine/chinese/wuntun-soup.md"
  # starter/
  ["starter/chicken-liver-pate.md"]="cuisine/french/snacks/chicken-liver-pate.md"
  ["starter/club-sandwich.md"]="cuisine/american/club-sandwich.md"
  ["starter/flash-fried-paprika-squid.md"]="cuisine/spanish/snacks/flash-fried-paprika-squid.md"
  ["starter/moules-mariniere.md"]="cuisine/french/moules-mariniere.md"
  ["starter/nonya-pork-satay.md"]="cuisine/malaysian/snacks/nonya-pork-satay.md"
  ["starter/prawn-cocktail.md"]="cuisine/british/snacks/prawn-cocktail.md"
  ["starter/smoked-salmon-blini.md"]="cuisine/russian/snacks/smoked-salmon-blini.md"
  ["starter/spring-rolls-fiery-chilli-sauce.md"]="cuisine/chinese/snacks/spring-rolls-fiery-chilli-sauce.md"
  ["starter/steak-tartare.md"]="cuisine/french/steak-tartare.md"
  # tarts/
  ["tarts/savoury/semi-confit-cherry-tomato-tart.md"]="cuisine/french/snacks/semi-confit-cherry-tomato-tart.md"
  ["tarts/sweet/apple-tart.md"]="cuisine/french/desserts/apple-tart.md"
  ["tarts/sweet/apricot-tart.md"]="cuisine/french/desserts/apricot-tart.md"
  ["tarts/sweet/lemon-tart.md"]="cuisine/french/desserts/lemon-tart.md"
  ["tarts/sweet/strawberry-tart.md"]="cuisine/french/desserts/strawberry-tart.md"
  ["tarts/sweet/custard-tart.md"]="cuisine/british/desserts/custard-tart.md"
  ["tarts/sweet/rhubarb-tartlets.md"]="cuisine/british/desserts/rhubarb-tartlets.md"
  ["tarts/savoury/lightly-curried-seafood-flan.md"]="cuisine/french/side-dishes/lightly-curried-seafood-flan.md"
)

for src in "${!MOVES[@]}"; do
  dst="${MOVES[$src]}"
  if [ ! -f "$src" ]; then
    echo "MISSING: $src"
    continue
  fi
  src_dir=$(dirname "$src")
  dst_dir=$(dirname "$dst")
  slug=$(basename "$src" .md)
  mkdir -p "$dst_dir/resources/thumbs"
  git mv "$src" "$dst" 2>&1 | head -1 || true
  for ext in jpg jpeg png gif PNG; do
    for kind in "resources/$slug.$ext" "resources/thumbs/$slug.$ext"; do
      if [ -f "$src_dir/$kind" ]; then
        target_dir=$(dirname "$dst_dir/$kind")
        mkdir -p "$target_dir"
        git mv "$src_dir/$kind" "$dst_dir/$kind" 2>&1 | head -1 || true
      fi
    done
  done
  echo "moved $src -> $dst"
done
