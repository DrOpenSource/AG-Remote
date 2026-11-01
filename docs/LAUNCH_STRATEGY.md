# Launch Strategy

Where to post Antigravity Remote, in what order, and with which free tools. The copy for each channel is in [MARKETING_KIT.md](MARKETING_KIT.md).

Written 2026-10-30, after 0.2.5. Starting point: 842 Open VSX downloads, 1 review, 1 GitHub star, 2 GitHub followers.

---

## The plan in one paragraph

The people who need this are already Antigravity users, so start where they are (r/google_antigravity, the Google AI Developers Forum, the awesome-Antigravity lists) before going broad. Your own story (a doctor building with AI agents, strict process, six releases in three days) carries LinkedIn and X. Hacker News comes second, once the demo video exists and the security docs are in place, because HN will read the crypto. Product Hunt waits until 0.3. Everything here is free.

---

## 1. Before posting anything (31 Oct to 3 Nov)

| # | Task | Why |
|---|---|---|
| 1 | Record the 20 to 30 second demo video and the three screenshots (kit section 4). | Posts with a video get read; text-only dev-tool posts mostly don't. |
| 2 | Add the GIF and screenshots to the top of the README. | Every channel sends people to the README or the Open VSX page. |
| 3 | Upload `assets/banner.png` as the GitHub social preview. | Shared links show a card instead of a blank box. |
| 4 | Add `SECURITY.md` (how to report, what's in scope, "protocol not externally reviewed yet"). It's already on the 0.3 roadmap. | Security is the pitch, so HN and Reddit will look for it. Private vulnerability reporting is already on. |
| 5 | Add `CONTRIBUTING.md` and issue templates (bug report asks for Copy Diagnostics). | Turns "it doesn't work" comments into useful issues. |
| 6 | Add GitHub topics: `google-antigravity`, `ai-agents`, `mobile`, `open-vsx`, `coding-agent`. | Topic pages are how people browse GitHub. |
| 7 | Ask the friends and the tester who used it to leave an Open VSX review. | One review next to 842 downloads looks empty. Reviews are what people check in the Extensions panel. |
| 8 | Set up F5Bot alerts (see Tools). | You'll see people asking "can I use Antigravity from my phone?" and can answer them. |

---

## 2. Order of launch

US midterm elections are on Tuesday 3 November, which will crowd US feeds, so the first public post is Wednesday 4 November.

| When | Channel | Notes |
|---|---|---|
| **Wed 4 Nov** | LinkedIn post + X thread | Your network first. LinkedIn links go in the first comment. Reply to every comment that day. |
| **Thu 5 Nov** | r/google_antigravity | The core audience. Check rules and flair. Stay in the comments for 2 hours. |
| **Thu 5 Nov** | Google AI Developers Forum (discuss.ai.google.dev) | Where Antigravity users report problems. Other remotes have launched here. |
| **Fri 6 Nov** | PRs to the awesome-Antigravity lists | See section 4. |
| **Sat 7 to Sun 8 Nov** | r/vibecoding, then r/SideProject | One subreddit a day, each post rewritten for that crowd, never the same text cross-posted. |
| **Mon 9 Nov** | Write-up on dev.to (and your own site if you have one) | "Antigravity changed its agent under my extension twice in one week": the agy switch, the one-agent-per-window bug, how parent-process matching fixed it. A technical story gets shared where an announcement doesn't. |
| **Tue 10 or Wed 11 Nov, 8 to 9 am US Eastern (6:30 to 7:30 pm IST)** | Show HN | Link the GitHub repo. Post the first comment from the kit straight away. Clear the evening to answer comments. |
| **Week of 9 Nov** | DevHunt and Peerlist Launchpad (free options) | Developer-only launch boards. Peerlist is strong in India. Skip the paid "featured" options. |
| **After 0.3 ships** | Product Hunt, r/opensource, r/webdev (Showoff Saturday) | See section 5. |
| **After "run your own relay" (0.5)** | r/selfhosted | Only fits once people can self-host the relay. |

After launch week: one short post per release on X and LinkedIn (what changed, a 10-second clip). Shipping often is the story; keep showing it.

---

## 3. Subreddits

Only r/google_antigravity was confirmed by search. For every row, read the sidebar rules and the last week of posts before posting. Several subreddits require a minimum karma or account age, or limit self-promotion to one day a week.

| Subreddit | Fit | Angle |
|---|---|---|
| r/google_antigravity | Best | User to user: "I built this for my own long tasks." Full feature list and limits. |
| r/vibecoding | Good | People who let agents run long. Lead with the "agent stalls while you're away" problem. |
| r/SideProject | Good | Builder story: doctor building with AI, six releases in three days. Loosely moderated. |
| r/developersIndia | Good, strict rules | Check for the showcase thread or flair; post only there. Your home audience. |
| r/coolgithubprojects | OK | Short post with the repo link and the GIF. |
| r/AI_Agents, r/ChatGPTCoding | OK | Human-in-the-loop approvals for agents in general. Mention it's Antigravity only, up front. |
| r/opensource | Later | Wants posts about the open-source side: MIT, zero running cost, inviting crypto review. |
| r/webdev | Later | Self-promotion only in Showoff Saturday. |
| r/selfhosted | After 0.5 | Only once the relay is self-hostable. |
| **Skip:** r/programming | | Doesn't allow "I built this" posts. A technical article might pass later. |
| **Skip:** r/vscode | | It doesn't work in plain VS Code; the comments will say so. |

**Reddit rules of thumb**

- Say you made it, in the first line.
- Don't ask for upvotes, anywhere. Reddit and HN both detect vote rings and bury the post.
- Answer every comment, especially the critical ones, without arguing. "Good point, opened issue #N" is the best possible reply.
- If a post gets removed, message the mods politely and ask what would be allowed. Don't repost.

---

## 4. Lists, directories and listings

| Where | What to do |
|---|---|
| [MichaelZelbel/awesome-antigravity](https://github.com/MichaelZelbel/awesome-antigravity) | "Antigravity IDE extensions" list, active (updated 30 Oct). Best fit. Read its CONTRIBUTING, open a PR adding one line. |
| [ZhangYu-zjut/awesome-Antigravity](https://github.com/ZhangYu-zjut/awesome-Antigravity) | Largest list (157 stars). Check whether it has a tools/extensions section first. |
| [ilyassbourass/awesome-antigravity](https://github.com/ilyassbourass/awesome-antigravity) | Small, but lists extensions. |
| Open VSX listing | Most installs come from here, because Antigravity's Extensions panel uses it. Make sure the README there shows the GIF (it uses the packaged README, so it needs a release after the README change). |
| DevHunt, Peerlist Launchpad | Free launches. Use the short blurb from the kit. |

---

## 5. Product Hunt: not yet

You can do it (it's free and anyone can post their own product), but now is the wrong time.

- **The audience is too broad.** Product Hunt voters are mostly founders and general tech people. A remote for one specific IDE's agent is a niche they scroll past. Show HN and the Antigravity communities reach the people who'd install it.
- **It rewards a ready network.** Launches that do well have a gallery, a video and people already following the maker. With 2 GitHub followers and no demo yet, it would sink without a trace, and you only get a real first launch once.
- **It's a better story with 0.3.** Voice input, readable replies and any file type make "talk to your coding agent from your phone" a much stronger headline.

**When 0.3 is out:** launch on Product Hunt with the video, 4 or 5 gallery images (approval card, notification, "Allow this phone?", architecture diagram), the tagline from the kit and a maker comment written like the LinkedIn post. Launches go live at 12:01 am Pacific (1:31 pm IST). Tell your network the product is live and ask for feedback, not votes. Read Product Hunt's own launch guide the week before, since its rules change.

---

## 6. Tools

All free, or free for what you need. You said to skip paid tools, so paid ones are left out.

**Demo video and images**

| Tool | Use |
|---|---|
| OBS Studio | Record the PC screen. |
| Your phone's built-in screen recorder | Record the phone side. |
| Clipchamp (comes with Windows 11) | Put PC and phone side by side, trim, export MP4. |
| ScreenToGif | Turn the MP4 into a small GIF for the README. |
| Shots.so | Put phone screenshots in a device frame. |

**Posting and listening**

| Tool | Use |
|---|---|
| Typefully or Buffer (free plans) | Draft and schedule the X thread and LinkedIn post. Check what their free plan includes before relying on it. |
| F5Bot | Free email alerts when Reddit or Hacker News mentions your keywords. Suggested: `antigravity remote`, `antigravity phone`, `antigravity mobile`, `antigravity approve`, `agy remote`. |
| Avoid: GummySearch | Closing down (Reddit API dispute). |

**Measuring**

| Tool | Use |
|---|---|
| GitHub Insights → Traffic | Visitors, clones and **referring sites** for the last 14 days. This is how you'll know which post worked. Check it during launch week, before the 14 days roll off. |
| Open VSX and Marketplace pages | Download counts. Note them before each post (baseline: 842 on Open VSX, 30 Oct). |
| star-history.com | Stars over time, for later posts. |
| Cloudflare dashboard (Workers and Durable Objects usage) | Check it on Show HN day. A popular post means many new relay connections, and the free plan has daily limits. If usage nears them, the fallbacks are Wi-Fi mode and, later, your own relay (ROADMAP keeps costs at zero). |

**Claude connectors (need authorising first)**

Canva and Ahrefs connectors are installed but not signed in. Once you authorise them in your claude.ai connector settings, Canva could make the LinkedIn carousel and Product Hunt gallery, and Ahrefs could check what people search for around "Antigravity remote". Until then they're unavailable.

---

## 7. What to measure

For each post, write down the date, the link, and the Open VSX downloads and GitHub stars before and 48 hours after. After launch week, put the numbers in a table here. Next time, repeat what worked and drop what didn't.

| Date | Channel | Link | Downloads before → after | Stars before → after | Notes |
|---|---|---|---|---|---|
| | | | 842 → | 1 → | |
