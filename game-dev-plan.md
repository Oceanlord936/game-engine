# Game dev plan — 2D bomb-platformer

## Vision

A 2D competitive platform-fighter combining Bomberman-style bomb mechanics
with Smash Bros-style platform combat. Flat 2D art, lightweight (no 3D
textures). Priorities: art expression and engine fundamentals first,
game mechanics complexity kept intentionally lean.

- Every character can place a **basic bomb**, used both offensively and as
  a traversal tool (bomb-jump: use the blast to boost a jump).
- Every character has **4 unique abilities** on top of the base kit.
- Four character categories:
  - **Bomber** — special bomb variants on top of the regular bomb
  - **Attacker** — special mobility skill + i-frames
  - **Shooter** — beam or projectile attacks
  - **Blocker** — generates blocks + healing
- Stats that vary per character: speed, health, flame range.
- Reference points: Bombergirl (character categories), Brawlhalla /
  Rivals of Aether (platform-fighter structure).

## Engine: Godot 4

Chosen because:
- 2D is architecturally separate from 3D — no forced physics complexity
- `CharacterBody2D` gives full manual movement control (needed for the
  bomb-jump mechanic)
- `Resource`-based composition fits the ability-slot architecture directly
- Free, open source, no royalties
- Built-in high-level multiplayer API (ENet) matches the peer-hosted
  networking model below
- Proven cross-platform: real shipped commercial titles (Brotato, Cassette
  Beasts, Dome Keeper, Luck Be a Landlord) exported to PC, mobile, and
  console from the same Godot project

Known limitation to revisit later: no built-in rollback netcode — the
community `GodotRollbackNetcode` addon covers this if/when precise combat
timing needs it.

## Networking model: peer-hosted (listen server)

No dedicated always-on server. One player's PC hosts and has authority;
others connect directly.

| Stage | Approach | When |
|---|---|---|
| A | Direct LAN connection | First networking prototype |
| B | UPnP auto port-forwarding | Real internet play, still zero server cost |
| C | Lightweight matchmaking/signaling (room codes) or Steamworks relay | Once ready for wider/public play |

A matchmaking/signaling layer, if added later, only helps players find
each other — it never runs game logic. The host's PC remains the sole
authority over the actual match.

## Unit conventions

Fixed so every system (levels, character, camera, physics) references the
same grid instead of eyeballed numbers.

- **1 Unity unit = 1 cell = 1 meter.** Matches Unity's default physics
  tuning (gravity `-9.81`, etc.), so we don't have to retune physics to
  compensate for an unusual scale.
- **Pixels Per Unit = 100** for all imported art (Unity's default). If a
  drawing is meant to be 2 units tall, export/draw it at 200px tall (or
  adjust that sprite's PPU import setting to make the math work) —
  either way, one project-wide PPU convention.
- **Keep `Transform.localScale` at `(1,1,1)`** for anything using real
  art. Size comes from the sprite's pixel dimensions ÷ PPU, not from
  stretching the transform — stretching distorts detailed art (it's only
  safe for the current flat-color placeholder blocks, which get replaced
  later).
- **Level geometry is defined in whole cell coordinates**, converted to
  world position/size by a `FromCells(x, y, width, height)`-style helper
  (see `LevelBuilder.cs`) rather than hand-written floats — keeps rooms
  snapping together like Lego as the map grows.
- **Character baseline size: 3 units wide x 6 units tall.** (Scaled up 3x
  from the original 1x2 baseline for easier detail work while posing the
  rig.) Drives step heights, doorway sizes, and jump-gap tuning — Room A's
  platforms/doorways and the jump-height numbers still assume the old 1x2
  scale and need rebalancing to match before it's used as a real level again.
- Editor GUI placement (when needed) should use `Edit > Grid and Snap
  Settings` with increment `1` to stay aligned to the same grid.

## Character/ability architecture

Composition over inheritance, using Godot `Resource` objects:

- **Character** = base stats (speed, health, flame range) + universal
  bomb ability + 4 ability slots
- Each ability is a self-contained `Resource`/script implementing a
  common interface (`activate()`, cooldown, etc.)
- Category (Bomber / Attacker / Shooter / Blocker) is just a preset set
  of 4 abilities plugged into those slots — not a subclass

## Start plan (weeks 1–4)

1. **Install Godot 4** and set up a new 2D project; get familiar with the
   scene tree, inspector, and node system.
2. **Build a minimal test scene** — flat ground, camera, a circle sprite
   as a `CharacterBody2D` ball. No art, no polish.
3. **Script core movement** — left/right + jump via `move_and_slide()`.
   Tune gravity/speed/jump height until it feels responsive.
4. **Prototype the bomb-jump in isolation** — bomb placement, explosion,
   jump boost from the blast. This is the game's unique hook.
5. **Launch two local instances** — Debug menu → Run Multiple Instances.
6. **Wire up basic position sync** — `ENetMultiplayerPeer`
   (`create_server` / `create_client`) + `MultiplayerSynchronizer` to
   replicate the ball's position between instances.
7. **Confirm live interaction across instances** — move the ball in one
   instance, verify it updates in the other in real time.

## Long-term roadmap

| Phase | Focus | "Done" looks like |
|---|---|---|
| 1. Foundation | Engine basics, movement feel, bomb-jump, network sync proof | Networked ball moves/jumps/bomb-jumps identically on two instances |
| 2. Single-player sandbox | Full Bomber character, hazards, test level | One category's full 4-ability kit feels good solo |
| 3. Multiplayer integration | Host-authoritative conversion of the sandbox | 2–4 players on the same LAN play a real match |
| 4. Ability system expansion | One character per remaining category | Architecture proven across very different ability types |
| 5. Real internet connectivity | UPnP, shareable room code, disconnect handling | A friend outside the LAN can join without manual setup |
| 6. Roster expansion | More characters per category | Content work, not systems work |
| 7. Art expression layer | Shaders, VFX, visual identity | The game looks like the intended vision, not placeholders |
| 8. Polish & playtesting | Balance passes, real matches with friends | Ongoing |

## Core principle to hold onto

Keep movement/bomb logic as a pure function of state + input, separated
from rendering and raw `Input` calls. The host needs to simulate this
authoritatively; clients need to receive state without duplicating the
simulation. Building this separation during Phase 1, while the only
feature is "ball moves and jumps," keeps every later phase network-ready
instead of requiring a rewrite in Phase 3.

## Open questions to revisit

- GDScript vs C#: GDScript has the most mature mobile export path today;
  C# mobile export has improved with .NET 8 support in Godot 4.6 but is
  worth re-checking before committing.
- Matchmaking approach for wider-than-friends play (custom lightweight
  signaling server vs. Steamworks, if publishing there).
- Whether rollback netcode becomes necessary once combat timing gets
  precise.
