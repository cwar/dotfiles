# Interview Types Reference

## Table of Contents
- [Tech Screen](#tech-screen)
- [System Design Final](#system-design-final)
- [Programming Final](#programming-final)
- [Domain Interview Final](#domain-interview-final)
- [Values Interview](#values-interview)
- [Staff Engineering](#staff-engineering)

---

## Tech Screen

**Duration:** 75 minutes
**Goal:** Evaluate likelihood of success in final round interviews.

### Timeline

| Section | Duration | Focus |
|---------|----------|-------|
| Introductions & Overview | 5 min | Set the stage, explain format, no-AI policy |
| Project Discussion | 10-15 min | Architectural understanding, get candidate comfortable |
| Domain Questions | 10-15 min | 2-4 technical questions from domain bank |
| Coding Exercise | 30-40 min | Problem-solving and code fluency |
| Wrap Up | 5-10 min | Candidate questions, sell Spotify |

### Section Details

#### 1. Introductions (5 min)
Opening script should cover:
- Your name, role, team, tenure at Spotify
- Interview structure (75 min, project discussion → domain questions → coding)
- "Completing all questions is NOT the primary goal - these are tools to understand your experience"
- "Be honest about what you know, try your best, feel free to ask questions"
- AI tools NOT permitted during interview

#### 2. Project Discussion (10-15 min)
**Goal:** Evaluate architectural understanding and system design experience.

Icebreaker (2 min): "Tell me briefly about your current work."
Main question: "Describe a project you're architecturally familiar with — one where you had significant input on the design or worked closely with the architects."

Follow-up probes (pick 2-3):
- "What were the most successful design decisions? Why?"
- "Describe the key components and technologies used. What was the rationale?"
- "What scalability challenges did you encounter?"
- "If you could change one thing about the architecture, what would it be?"

Then ask: "Which programming language are you most comfortable with for today's coding exercise?"

#### 3. Domain Questions (10-15 min)
Opening: "We have a variety of questions with varying difficulties. We want to find areas where you're strong, not dwell on concepts you haven't worked with."

Pick 2-3 domain questions + both GenAI questions. See `domain-questions.md` for the full question bank.

#### 4. Coding Exercise (30-40 min)
Transition: "Now we'll move to a coding exercise. It's fine to write pseudo-code for things you don't remember exactly."

Setup CoderPad, share link. See `coding-problems.md` for problems.

#### 5. Wrap Up (5-10 min)
"Do you have any questions for me about the role, the team, or Spotify?"
Share what you love about working at Spotify.
"The recruiter will be in touch with next steps."

### Scoring Areas
- Communication & Collaboration (1-4)
- Architectural Understanding (1-4)
- Problem Solving (1-4)
- Code Fluency (1-4)
- Testing (1-4, optional)
- GenAI Tools Familiarity (1-4)

---

## System Design Final

**Duration:** 60 minutes
**Goal:** Candidate designs a system to solve a real-world problem with no single correct solution.

### Timeline

| Section | Duration | Focus |
|---------|----------|-------|
| Introductions & Overview | 5 min | Set the stage |
| System Design Exercise | 30-40 min | Core design problem |
| Wrap Up | 5-10 min | Q&A |

### Section Details

#### 1. Introductions (5 min)
Key points to communicate:
- This is NOT a coding interview, there is NO correct answer
- Interested in how they think through problems, make tradeoffs, communicate
- Use whiteboard/FigJam as brainstorming tool, feel comfortable erasing
- Think of interviewer as a stakeholder - ask questions about requirements
- Feel free to dive deeper into areas of strength
- AI tools NOT permitted

#### 2. System Design Exercise (30-40 min)
Let candidate drive requirements gathering. Probe these areas as they work:
- Upload/input flow
- Processing pipeline
- Storage & serving
- Content moderation / validation
- Multi-region / availability
- Failure modes & operations

Probing questions by phase:
- **Early** (requirements): "What are the most important requirements?", "What would you tackle first?"
- **Mid** (details): "Walk me through the data flow for X", "What database would you use? Why?"
- **Late** (scale/ops): "What breaks first at 10x?", "How would you monitor this?", "What happens when X fails?"

### Scoring Areas
- Communication & Collaboration (1-4)
- Knowledge of Technologies / Domain Depth (1-4)
- Awareness of Side-Effects & Systemic Interactions (1-4)
- Informed Decision Making (1-4)
- Scalable & Flexible Design (1-4)
- System Engineering & Operations (1-4)
- Distributed Computing & Parallel Programming (1-4, Data Eng only)
- Web Applications & Services (1-4, Web/Fullstack only)

---

## Programming Final

**Duration:** 60 minutes
**Goal:** Assess programming skills with focus on data structures and algorithms.

### Timeline

| Section | Duration | Focus |
|---------|----------|-------|
| Introductions & Overview | 5 min | Set the stage |
| Coding Exercise | 30-40 min | 1-2 programming problems |
| Wrap Up | 5-10 min | Q&A |

### Section Details

#### 1. Introductions (5 min)
- Explain this is a programming exercise
- "Completing all questions is NOT the primary goal"
- AI tools NOT permitted

#### 2. Programming Exercise (30-40 min)
Select 1-2 questions with escalating difficulty. See `coding-problems.md`.
For Web interviews: single question with multiple sub-questions that fill the entire duration.

### Scoring Areas
- Communication & Collaboration (1-4)
- Problem Solving (1-4)
- Code Fluency (1-4)
- Testing (1-4)
- Error Handling (1-4, optional)
- Performance (1-4, optional)

---

## Domain Interview Final

**Duration:** 60 minutes
**Goal:** Assess domain-specific skills through case study or specialized exercise.

### Timeline

| Section | Duration | Focus |
|---------|----------|-------|
| Introductions & Overview | 5 min | Set the stage |
| Domain Exercise | 30-40 min | Domain-specific case study |
| Wrap Up | 5-10 min | Q&A |

### Domain → Exercise Mapping

| Domain | Exercise Type |
|--------|--------------|
| Backend | Backend Case Study |
| Core | Code Review |
| Data | Data Interview |
| Embedded | Code Review |
| ML | ML Breadth (+ optional ML Depth) |
| Mobile | IDE Mobile Interview |
| Security | Security Case Study |
| SRE | Backend Case Study |
| Web | Web Interview |

See `domain-questions.md` for domain-specific content.

### Scoring Areas (Backend Case Study)
- Communication & Collaboration (1-4)
- Problem Solving & Troubleshooting (1-4)
- System Knowledge (1-4)

---

## Values Interview

**Duration:** 60 minutes
**Goal:** Assess alignment with Spotify's values using the CAB Interview model.

### Structure
The values interview uses the company-wide interview script. It evaluates:
- Spotify's 5 core values
- Competence and Achievement
- Approach to diversity and inclusion

For senior+ candidates, also assess leadership competencies.

This is the ONE interview type where the resume IS reviewed (unlike other final rounds which are resumeless).

### Timeline

| Section | Duration | Focus |
|---------|----------|-------|
| Introduction | 5 min | Set the stage |
| Values Questions | 40-45 min | Behavioral questions based on CAB model |
| Wrap Up | 5-10 min | Q&A |

### Scoring Areas
- Values alignment (1-4)
- Competence & Achievement (1-4)
- Diversity & Inclusion awareness (1-4)
- Leadership (1-4, senior+ only)

---

## Staff Engineering

**Duration:** 90 minutes total (two 45-minute blocks)
**Goal:** Determine if candidate is Staff-level, assess technical leadership.

### Timeline

| Block | Duration | Interviewer | Focus |
|-------|----------|-------------|-------|
| Hiring Manager Session | 45 min | HM | Role fit, leadership, impact |
| Staff Engineer Session | 45 min | Staff Eng | Technical depth, system thinking |

### Each 45-min Block

| Section | Duration | Focus |
|---------|----------|-------|
| Introduction | 5 min | Set the stage |
| Project Discussion | 15-20 min | Architectural depth, leadership |
| Technical Questions | 15-20 min | Domain expertise, system design |
| Wrap Up | 5 min | Q&A |

### Key Differences from Standard Interviews
- Looking for cross-team impact and influence
- Technical strategy and vision
- Ability to mentor and grow other engineers
- System-level thinking beyond individual components

### Scoring Areas
- Technical Leadership (1-4)
- System Thinking (1-4)
- Communication & Influence (1-4)
- Domain Expertise (1-4)
- Mentorship & Growth (1-4)
