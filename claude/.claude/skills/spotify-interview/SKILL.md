---
name: spotify-interview
description: |
  Generate personalized Spotify engineering interview prep documents from a candidate's resume. Creates two Obsidian-flavored markdown notes: (1) a comprehensive Interview Document with scripted sections, resume-specific probing questions, coding/design problems, rubrics, and scoring sheets, and (2) a condensed Cheat Sheet for quick reference during the interview. Use this skill whenever someone needs to prepare for conducting a Spotify engineering interview, create interview scripts, generate interview prep documents, or mentions interview prep for any Spotify engineering role. Supports all interview types (tech screen, system design, programming, domain/case study, values, staff) and all domains (backend, data, web, mobile, ML, SRE, security, core, embedded) at any level (Associate through Senior+).
---

# Spotify Interview Prep Generator

Generate two personalized Obsidian notes to conduct a Spotify engineering interview: a full **Interview Document** and a **Cheat Sheet**.

## Inputs

Gather these from the user before generating:

1. **Resume** - Path to the candidate's resume (PDF or .docx). Read it with the appropriate tool.
2. **Interview type** - One of:
   - `tech-screen` (75 min) - Project discussion + domain questions + coding
   - `system-design` (60 min) - System design exercise (final round)
   - `programming` (60 min) - Coding/algorithms exercise (final round)
   - `domain` (60 min) - Domain-specific case study/exercise (final round)
   - `values` (60 min) - Behavioral/values interview (final round)
   - `staff` (90 min) - Staff engineering track (HM + Staff sessions)
3. **Level** - Target level: `associate`, `engineer-i`, `engineer-ii`, `senior`, or `staff`
4. **Domain** - Engineering domain: `backend`, `data`, `web`, `mobile`, `ml`, `sre`, `security`, `core`, or `embedded`
5. **Output directory** - Where to save the generated files

If the user doesn't specify all inputs, ask for the missing ones. The domain is needed for all types to select appropriate questions and rubrics.

## Workflow

### Step 1: Read the resume

Read the candidate's resume file. Extract:
- Full name
- Contact info (email, phone, location)
- Current and previous roles (company, title, dates, key focus)
- Education
- Technical skills (languages, frameworks, cloud, databases, etc.)
- Notable achievements with specific metrics (these become probing question targets)
- Total years of experience

### Step 2: Read relevant references

Based on the interview type and domain, read the appropriate reference files from `references/`:

| Interview Type | Read These References |
|---|---|
| `tech-screen` | `interview-types.md` (tech-screen section), `domain-questions.md`, `coding-problems.md`, `leveling.md` |
| `system-design` | `interview-types.md` (system-design section), `system-design-problems.md`, `rubrics.md`, `leveling.md` |
| `programming` | `interview-types.md` (programming section), `coding-problems.md`, `rubrics.md`, `leveling.md` |
| `domain` | `interview-types.md` (domain section), `domain-questions.md`, `rubrics.md`, `leveling.md` |
| `values` | `interview-types.md` (values section), `leveling.md` |
| `staff` | `interview-types.md` (staff section), `rubrics.md`, `leveling.md` |

### Step 3: Select questions and problems

Based on the interview type + domain + level, select:

- **Tech screen**: Pick 2-3 domain questions from the question bank matching the candidate's domain, plus both GenAI questions. Choose a coding problem appropriate for the level (simpler for associate/eng-i, more complex for eng-ii/senior). Select domain questions that let the candidate demonstrate strength based on their resume.
- **System design**: Pick a system design problem relevant to the domain. For backend, choose from: Custom Playlist Images, Ad Server, Spotify Playlist, Endsong Problem, Spotify Wrapped, Disk-based Object Cache. For data: Endsong or Wrapped. For web: Messenger Client, Friend Listening, Spotify Homepage.
- **Programming**: Pick 1-2 coding problems. For backend/data/SRE: File Deduplication, Sum-tree, Windowed Moving Median, Rank Tracks, Most Common Sequence, Model a List in Memcached. For web: Playlists, Number Wrapper, Track Plays.
- **Domain**: Select the appropriate case study for the domain (Backend Case Study, Data Interview, Web Interview, ML Breadth, Security Case Study, IDE/Mobile, Code Review, SRE Interview).
- **Values**: Use the CAB model interview structure.
- **Staff**: Use the Staff Tech Screen or Tech Leadership format.

### Step 4: Personalize probing questions

This is the most important step. Create resume-specific probing questions by:

1. Identify 3-5 **high-signal achievements** from the resume - things with specific metrics, system-scale claims, or architectural decisions
2. For each, write a probing question that tests whether the candidate truly understands what they claim
3. Frame questions as "Walk me through..." or "Tell me about..." to invite depth
4. Connect probes to the interview's evaluation criteria (e.g., link a scaling claim to the system design rubric's "Scalable & Flexible Design" area)

**Example pattern:**

| Resume Claim | Probing Question |
|---|---|
| "Reduced failures by 20% via SQS orchestration" | "Walk me through the SQS-based orchestration layer you built. How did you handle retries and throttling? What made it reduce failures by 20%?" |
| "Led multi-region Tier-1 migration" | "Tell me about the multi-region migration. What were the hardest technical decisions, and what would you do differently?" |

### Step 5: Generate the Interview Document

Create `Interview - [Candidate Name] [Interview Type].md` using this structure. Use Obsidian-flavored markdown throughout (callouts, wikilinks, highlights, comments, checkboxes).

#### Frontmatter

```yaml
---
title: "[Interview Type] - [Candidate Name]"
date: [today's date]
tags:
  - interview
  - [interview-type tag]
  - [domain tag]
  - hiring
candidate: [Full Name]
position: [Domain] Engineer [Level]
duration: [duration] minutes
status: scheduled
---
```

#### Document Structure

```markdown
# [Interview Type]: [Candidate Name]

## Candidate Background
[Table with name, location, email, experience, education]

### Summary
[2-3 sentence summary from resume]

### Work History
[Table: Company | Role | Dates | Key Focus]

### Technical Skills
[Table: Category | Details]

### Notable Achievements
> [!tip] High-Signal Discussion Points
> Bulleted list of resume achievements with specific metrics highlighted using ==highlights==

---

## Interview Timeline
[Table with sections, durations, focus areas - using [[#section]] wikilinks]

---

## [Section 1 - varies by interview type]
**Duration:** X minutes

### [Content appropriate to interview type]
[Scripts in > [!quote] callouts]
[Questions in > [!question]- collapsible callouts with answers]
[Important notes in > [!warning] or > [!info] callouts]

### Resume-Specific Follow-ups
> [!important] High-Signal Questions
[Table: Resume Claim | Probing Question]

---

## [Section 2 - main exercise]
**Duration:** X minutes

[Problem statement, solutions, follow-ups, what-to-watch-for tables]

---

## [Section 3 - Wrap Up]

---

## Evaluation Rubric
> [!abstract] Level Descriptions
[Level 1-4 descriptions table]

### Scoring Sheet
[Table: Area | Score (1-4) | Notes - with areas matching the interview type's rubric]

### Level Guidance
> [!tip] What to Expect from [Name] (~X years experience)
[Level-specific expectations based on their background]

---

## Pre-Interview Checklist
[Checkboxes for setup tasks]

---

## Interview Notes
[Empty code blocks for: section notes, overall impressions]

### Recommendation
- [ ] Strong Hire
- [ ] Hire
- [ ] No Hire
- [ ] Strong No Hire

**Suggested Level:**

---

## Related
[[Engineering Interviews]]
[[relevant links]]
```

### Step 6: Generate the Cheat Sheet

Create `Interview Cheat Sheet - [Candidate Name].md` - a condensed 1-2 page quick reference.

#### Frontmatter

```yaml
---
title: "Cheat Sheet - [Candidate Name] [Interview Type]"
date: [today's date]
tags:
  - interview
  - cheat-sheet
  - [interview-type tag]
---
```

#### Cheat Sheet Structure

```markdown
# [Candidate Name] - [Interview Type] Cheat Sheet

## Candidate Quick Facts
[Compact table: Experience, Current Role, Previous, Languages, Strengths]

---

## Timeline ([duration] min)
[Table: Section | Time | What to Do]

---

## [Main Content - condensed version of key questions/problems]
[Only the essential questions, problem statements, and solution summaries]
[Include solution comparison tables for coding problems]

---

## Key Probes for [Name]'s Experience
[Table: Resume Claim | Probe Question - the 3-5 best ones]

---

## What to Watch For
### Good Signs
[Bulleted list]
### Concerning Signs
[Bulleted list]

---

## Scoring (1-4)
[Table: Area | Score | Notes - empty for filling in]

---

## Level Expectations
[Brief description of what the target level looks like]

---

## Red Flags
[Bulleted list including AI usage signs]

---

## [Any quick reference needed - complexity cheat sheet, scale numbers, etc.]
```

### Step 7: Write the files

Use the Obsidian markdown skill patterns. Write both files to the user's specified output directory. Use Obsidian callout syntax throughout:
- `> [!quote]` for scripts
- `> [!question]-` (collapsible) for questions with answers
- `> [!tip]` for high-signal discussion points
- `> [!warning]` for required items or AI detection
- `> [!info]` for optional/contextual notes
- `> [!abstract]` for rubric summaries
- `> [!important]` for critical probing questions
- `> [!example]-` (collapsible) for solution code

Use `%%comments%%` for interviewer-only notes that shouldn't affect scoring. Use `==highlights==` for key metrics from the resume. Use `[[#section]]` wikilinks for internal navigation.

## Language Guidance

When selecting coding problems, note the recommended languages by domain:
- **Backend/Data/SRE**: Java, Python, Scala
- **Web**: JavaScript, TypeScript (vanilla preferred)
- **Mobile**: Kotlin, Swift
- **ML**: Python
- **Core**: C++
- **Embedded**: C, C++

Provide solution examples in the language most likely matching the candidate's resume. If the candidate knows multiple, provide examples in their strongest language.

## GenAI Questions

Always include GenAI questions regardless of interview type (except values). These are standard across all tech interviews:
1. "What GenAI tools do you use day-to-day? What do you find them most useful for?"
2. "When you use AI to help write code, how do you verify the output is correct?"

## AI Detection Reminders

Include in every interview document's opening script:
> "AI assistants or AI-generated code are not permitted during this interview."

And in the cheat sheet's red flags:
- Looking away / typing during questions
- Switching gaze to another monitor
- Answers that appear read out rather than spontaneous
- Inability to explain reasoning behind their solution
