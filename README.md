# BYM MR Viewer

BYM MR Viewer is a browser-based Map Room 3 viewer for Backyard Monsters Refitted. It lets you open the world map outside the game client, browse bases in your current world, search for players, apply filters, and inspect live map data.

## Features

- Live Map Room 3 map viewing
- Stable, local, or custom BYM server selection
- Per-user sign-in with your own BYM account
- Search for player bases by username
- Filters for wild bases, tribes, levels, and player ownership
- Leaderboards and world metadata
- Base details including range and outpost counts
- Refreshing the current world snapshot on demand

## How It Works

The viewer runs entirely in your browser. After you choose a server, it connects directly to that BYM server for sign-in, world data, leaderboards, and map data. Map graphics are loaded from the selected server's CDN.

Every network request (API calls and CDN asset loads alike) has a timeout, so a stalled connection — a dropped mobile network, a flaky proxy, a server that accepts the connection but never replies — fails with a clear message instead of hanging forever with no error ever surfacing. Single requests (login, session refresh, the map-version check, individual CDN assets) time out after 8 seconds; the ~60 chunked requests of a full-map preload get 20 seconds each, since a bigger payload legitimately needs more room. A bad token or dead connection surfaces almost immediately, since that check always happens before the slower full-map load starts.

Once a world's full map has loaded once, it's cached locally (IndexedDB) so the next sign-in doesn't have to re-fetch it — but that means what's on screen right after loading can be from that cache rather than freshly fetched. A small "Map data as of Xm ago" label near the refresh button shows how old it actually is; hit refresh to get current data.

## Interface

Everything lives in a top bar plus floating controls over the map — there's no collapsible side panel:

- **Sign in** (top bar, right) opens a popover with the server picker and login/logout — the one control that's always reachable, since a server switch or login can happen at any time.
- **Leaderboards** (top bar, left) opens a popup with the MR3 world list and leaderboards, defaulting to your own account's current world once you're signed in. This is stats only — picking a different world here does not change which world's map you're viewing. The API only ever returns cell data for your logged-in account's current world.
- **Search** and **Filters** (floating buttons over the map, top-right) open in place, side by side if both are open. Search jumps to a player's base; filters highlight bases by type, tribe, level, or owner.
- Cell details appear in a floating panel (top-left) on hover, and stay pinned with a close button once you click a cell.
- Refresh, find home, and zoom stay as floating controls bottom-right. Refresh has a 60-second cooldown, shown as a badge on the button.

## Credentials and Privacy

Your BYM email and password are only sent to the server you choose in the viewer:

- `Stable` sends them to the live Backyard Monsters Refitted server
- `Local` sends them to your local BYM server
- `Custom` sends them to the custom host and port you enter

The viewer does not route your credentials through any separate backend of its own.

## Important Note

The current BYM API only exposes Map Room 3 cell data for the authenticated player's current world. Because of that, the map view can only render the world your logged-in account is currently in, even though the viewer can still show metadata and leaderboards for other MR3 worlds.

## Running It Locally

This repository includes a Python server for local/development use.

You need Python 3 installed.

From the project root, run:

```bash
python3 dev_server.py
```

Then browser to:

```text
http://localhost:8080
```

## Optional Server Settings

The local file server supports a few optional environment variables:

- `HOST` default: `0.0.0.0`
- `PORT` default: `8080`
- `STATIC_DIR` default: `app/static`

Example in PowerShell:

```powershell
$env:PORT=9090
python dev_server.py
```

## Bug Reports and Feature Requests

For bug reports and feature requests, please open an issue on our [issue tracker](https://github.com/PsychoTea/bym-mr-viewer/issues).
