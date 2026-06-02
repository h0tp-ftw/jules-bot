## PokeAPI Reference

Use PokeAPI to fetch official Pokémon data (stats, moves, abilities, etc.) to ensure Ankimon data is accurate.

- **Base URL**: `https://pokeapi.co/api/v2/`
- **Pagination**: Append `?limit=X&offset=Y`. Default limit is 20.

### Key Endpoints
| Endpoint | Description | Example Lookup |
| :--- | :--- | :--- |
| `pokemon/{id\|name}` | Basic data: stats, types, abilities, moves. | `pokemon/pikachu` |
| `pokemon-species/{id\|name}` | Flavor text, growth rates, habitat, evolution-chain link. | `pokemon-species/25` |
| `ability/{id\|name}` | Detailed ability effects and descriptions. | `ability/static` |
| `move/{id\|name}` | Move stats: power, accuracy, PP, type, effect. | `move/thunderbolt` |
| `type/{id\|name}` | Damage relations (double-damage-to, etc.). | `type/electric` |
| `evolution-chain/{id}` | Evolutionary trees (Note: IDs only, no names). | `evolution-chain/10` |
| `item/{id\|name}` | Item descriptions and categories. | `item/master-ball` |

### Data Structures
- **Named Resources**: Most endpoints accept names (lowercase, hyphenated).
- **Unnamed Resources**: `evolution-chain`, `machine`, and `contest-effect` only accept IDs.
- **Localized Text**: Look for `flavor_text_entries` and filter for `language: { name: "en" }` to get English descriptions.
