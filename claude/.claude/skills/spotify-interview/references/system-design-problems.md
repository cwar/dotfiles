# System Design Problems

## Problem Selection by Domain

| Domain | Recommended Problems |
|--------|---------------------|
| Backend | Custom Playlist Images, Ad Server, Spotify Playlist, Disk-based Object Cache |
| Data | Endsong Problem, Spotify Wrapped |
| Web / Fullstack | Messenger Client, Friend Listening, Spotify Homepage |
| Mobile | iOS/Android System Design Bank |
| Core | Disk-based Object Cache, Data Model for Music Player, Visual Git Client |
| SRE | Endsong Problem, Custom Playlist Images |
| Embedded | Embedded System Design Bank |

---

## Custom Playlist Images

**Prompt:** "Design a system that allows users to set custom images for their playlists."

**Context to share:**
- Users can upload their own image OR the system auto-generates a collage from album art
- Images displayed across all Spotify clients (mobile, desktop, web, TV)
- Some playlists viewed millions of times per day

### Requirements (share when asked)

| Area | Details |
|------|---------|
| Scale | Billions of playlists, ~1M image uploads/day |
| Image types | User upload OR collage from album art |
| Image sizes | Thumbnail (60px), medium (300px), large (640px) |
| Latency | Upload < 5 seconds, serving < 100ms |
| Storage | Indefinitely, but can regenerate collages |
| Validation | No NSFW, copyright concerns |
| Global | Users everywhere |

### Key Design Challenges to Probe

1. **Upload Flow** - Presigned URLs, client-side validation, async vs sync
2. **Image Processing Pipeline** - Queue-based processing, resize, format conversion, validation
3. **Auto-Generated Collages** - When to generate, caching, album art sourcing, layout logic
4. **Storage & Serving** - Object storage + CDN, cache headers, URL versioning
5. **Content Moderation** - Automated scanning, async pipeline, appeal process, fallbacks
6. **Multi-Region & Availability** - CDN edge locations, replication, fallback strategies

---

## Ad Server

**Prompt:** "Design a system that serves targeted ads to Spotify users during their listening sessions."

### Key Areas

| Area | Discussion Points |
|------|-------------------|
| Ad Selection | Targeting criteria, real-time bidding, personalization |
| Latency | Strict real-time requirements for ad serving |
| Throughput | Millions of ad requests per second |
| Tracking | Impressions, clicks, conversions |
| Frequency Capping | Don't show same ad too often |
| Revenue Optimization | Auction mechanics, fill rate |

---

## Spotify Playlist System

**Prompt:** "Given how Spotify's playlist system works, how would you design such a system?"

### Key Questions
- What happens if two clients update playlists at the same time? (conflict resolution)
- How do you push changes to all clients? (real-time sync)
- What happens if the playlist is shared/public? (scaling reads)
- How do you handle collaborative playlists?

---

## Endsong Problem

**Prompt:** "Using EndSong logs located on access points around the world, create a dashboard that displays the number of monthly streams for internal users."

**Setup context:**
- EndSong logs: messages sent from client when they finish listening to a song (very wide messages)
- Sent from client to Access Points (APs)
- APs write logs to hourly rotated files, gzipped, few days retention
- APs are numerous (hundreds), located worldwide in ~3 datacenters

**Requirements:**
- Monthly streams = logs received in previous 30 days (rolling)
- Dashboard updates daily

**Scale facts (share if asked):**
- 1 day of endsong logs ≈ 1TB of data, ~2B rows (avg 25k rps)

**Evaluation focus:** How they move data between systems while thinking about scalability, monitoring, timing, and extensibility. NOT about data manipulation.

---

## Spotify Wrapped

**Prompt:** "Create an additional Wrapped-like experience:"
1. Country Weekly Wrapped - Top 50 tracks per country based on last week's data (country, track_name, count)
2. Top 50 users per artist (artist, user, count)

**Input schemas:**
- EndSong: (user_id, track_id, timestamp, platform: [Mobile, Desktop, Web])
- Metadata: (track_id, track_name, artist_name)
- UserSnapshot: (user_id, country)

**Limitations:** Data too big for one machine.

**Concepts to test:**
- Schema design and data modeling
- Join strategies (key types, missing data, skewness)
- Infrastructure estimation
- Orchestration and scheduling
- Scaling to 1000x
- Monitoring

---

## Disk-based Object Cache (Core)

**Prompt:** "Design a disk-based object cache."

**Tell the candidate:**
- Hold thousands of objects of different sizes
- Key-Value mapping where both are blobs
- Must be cross-platform
- Example: store metadata, music files, images

**Listen for:** Constraints, class diagrams, filesystem layout
**Ask about:** Filesystem/OS considerations, algorithmic complexity
**Later:** After deployment to many customers, add a feature requiring on-disk format change (versioning)

---

## Data Model for Music Player (Core)

**Prompt:** "Design the data model for a music player in C++."

**Must allow:**
- Add and remove tracks
- Filter based on terms
- Search based on terms

**Look for:** Class diagrams, design patterns, extensibility
**Bonus:** Generic metadata types, value type extensions

---

## Visual Git Client (Core, experimental)

**Prompt:** "Design the model for a visual Git client showing a commit DAG."

**Constraints:**
- UI performance critical for scrolling
- Support thousands of nodes/edges
- Limited memory
- Disk reloading is slow
- Low-level UI operations expensive, but creating views is fast (views expensive in memory)

**Ask about:** Internal graph representation, MVC/MVVM model, scrolling/caching algorithms

---

## Evaluation Approach for All System Design

Let the candidate drive requirements gathering. Good candidates will:
- Ask clarifying questions before designing
- Do back-of-envelope calculations
- Discuss tradeoffs (not just one option)
- Consider failure modes and operations
- Connect to real experience
- Treat interviewer as collaborator
