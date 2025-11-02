# Building an Interactive Voting App with Vite, React, Supabase, and Vercel

A complete tutorial for creating a full-stack voting application for "50 Things Sasha Knows"

## Table of Contents
1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Project Setup](#project-setup)
4. [Database Setup with Supabase](#database-setup-with-supabase)
5. [Frontend Development](#frontend-development)
6. [Deployment with Vercel](#deployment-with-vercel)
7. [Custom Domain Configuration](#custom-domain-configuration)
8. [Key Learnings](#key-learnings)

---

## Overview

This tutorial walks through building a voting application where users can:
- View 50 items from Sasha Chapin's essay
- Select multiple items they find resonant
- Submit votes and see cumulative results
- View a bar chart visualization of all votes
- Vote again for a fresh session

**Live Demo:** [sasha.moontowermeta.com](https://sasha.moontowermeta.com)

---

## Tech Stack

### Frontend
- **Vite** - Fast build tool and dev server
- **React 18** - UI framework
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling with Moontower design system
- **Recharts** - Data visualization library

### Backend
- **Supabase** - PostgreSQL database with real-time subscriptions
- **PostgreSQL** - Relational database

### Deployment
- **Vercel** - Hosting and continuous deployment
- **GitHub** - Version control

---

## Project Setup

### 1. Initialize Vite + React Project

This project was built on an existing Vite + React setup. If starting fresh:

```bash
npm create vite@latest my-voting-app -- --template react-ts
cd my-voting-app
npm install
```

### 2. Install Dependencies

```bash
# Supabase client
npm install @supabase/supabase-js

# Charts library (Recharts already installed in this project)
npm install recharts
```

### 3. Environment Variables

Create `.env.local` in project root:

```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

**Important:** Add `.env.local` to `.gitignore` to keep credentials secure.

---

## Database Setup with Supabase

### 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Create a new project
3. Note your Project URL and anon/public API key

### 2. Database Schema

Create two tables in Supabase SQL Editor:

#### Items Table
```sql
CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  description text,
  likes_count integer DEFAULT 0
);
```

#### Likes Table
```sql
CREATE TABLE likes (
  id serial PRIMARY KEY,
  item_id uuid REFERENCES items(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);
```

### 3. Populate Items Table

Insert the 50 items from Sasha Chapin's essay:

```sql
INSERT INTO items (label) VALUES
  ('Growth comes most reliably from "taking on a difficult project with some amount of public accountability."'),
  ('People often resist positive emotions the same way they resist negative ones, limiting their enjoyment.'),
  -- ... (add all 50 items)
  ('Almost nobody receives too many sincere compliments; "compliment them to their face. Then, compliment them behind."');
```

### 4. Database Triggers (Optional)

While we ended up calculating votes dynamically, you can set up triggers to auto-update `likes_count`:

```sql
-- Function to increment likes_count
CREATE OR REPLACE FUNCTION increment_likes_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE items
  SET likes_count = likes_count + 1
  WHERE id = NEW.item_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to decrement likes_count
CREATE OR REPLACE FUNCTION decrement_likes_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE items
  SET likes_count = likes_count - 1
  WHERE id = OLD.item_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Triggers
CREATE TRIGGER trigger_increment_likes
AFTER INSERT ON likes
FOR EACH ROW
EXECUTE FUNCTION increment_likes_count();

CREATE TRIGGER trigger_decrement_likes
AFTER DELETE ON likes
FOR EACH ROW
EXECUTE FUNCTION decrement_likes_count();
```

### 5. Reset Database to Zero

When you're ready to launch fresh:

```sql
DELETE FROM likes;
UPDATE items SET likes_count = 0;
```

---

## Frontend Development

### 1. Supabase Client Setup

Create `src/lib/supabase.ts`:

```typescript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export interface Item {
  id: string
  label: string
  description?: string
  likes_count: number
}

export interface Like {
  id?: number
  item_id: string
  session_id: string
}
```

### 2. Main App Component Structure

The app has two view modes:

**Voting Mode:**
- Display all 50 items with numbering
- Moon emoji toggles (🌑 → 🌕)
- Vote counter at bottom
- Submit button (disabled until at least 1 vote)

**Results Mode:**
- Vertical bar chart (items 1-50 on x-axis, votes on y-axis)
- Unique voter count
- Ranked list of all items
- "Vote Again" button

### 3. Key Functions

#### Fetch Items with Vote Counts
```typescript
async function fetchItems() {
  // Fetch items
  const { data: itemsData, error: itemsError } = await supabase
    .from('items')
    .select('*')
    .order('id', { ascending: true })

  // Fetch all likes and count them per item
  const { data: likesData, error: likesError } = await supabase
    .from('likes')
    .select('item_id')

  // Count votes per item
  const voteCounts = new Map<string, number>()
  likesData?.forEach(like => {
    voteCounts.set(like.item_id, (voteCounts.get(like.item_id) || 0) + 1)
  })

  // Merge vote counts with items
  const itemsWithCounts = (itemsData || []).map(item => ({
    ...item,
    likes_count: voteCounts.get(item.id) || 0
  }))

  setItems(itemsWithCounts)
}
```

**Why count dynamically?** This ensures accurate vote counts regardless of trigger state and provides real-time data.

#### Submit Votes
```typescript
async function submitVotes() {
  const sessionId = crypto.randomUUID()

  // Batch insert all votes
  const votesToInsert = Array.from(userVotes).map(itemId => ({
    item_id: itemId,
    session_id: sessionId
  }))

  const { error } = await supabase
    .from('likes')
    .insert(votesToInsert)

  // Refresh data and show results
  await fetchItems()
  await fetchSessionCount()
  setViewMode('results')
}
```

#### Count Unique Voters
```typescript
async function fetchSessionCount() {
  const { data } = await supabase
    .from('likes')
    .select('session_id')

  const uniqueSessions = new Set(data?.map(like => like.session_id) || [])
  setSessionCount(uniqueSessions.size)
}
```

### 4. Chart Configuration

Using Recharts for vertical bar chart:

```typescript
<ResponsiveContainer width="100%" height={500}>
  <BarChart data={chartData}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis
      dataKey="name"
      label={{ value: 'Item Number', position: 'insideBottom' }}
    />
    <YAxis
      label={{ value: 'Votes', angle: -90, position: 'insideLeft' }}
    />
    <Tooltip content={CustomTooltip} />
    <Bar dataKey="votes" fill="#00C4E7" />
  </BarChart>
</ResponsiveContainer>
```

---

## Deployment with Vercel

### 1. Connect GitHub Repository

1. Push code to GitHub
2. Go to [vercel.com](https://vercel.com)
3. Click "Add New Project"
4. Import your GitHub repository

### 2. Configure Build Settings

Vercel auto-detects Vite projects, but verify:

- **Framework Preset:** Vite
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- **Install Command:** `npm install`

### 3. Environment Variables

In Vercel project settings:
1. Go to **Settings** → **Environment Variables**
2. Add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Apply to: Production, Preview, Development

### 4. Deploy

Click "Deploy" - Vercel will:
- Install dependencies
- Run TypeScript compilation
- Build with Vite
- Deploy to CDN

---

## Custom Domain Configuration

### 1. Add Domain in Vercel

1. Go to project **Settings** → **Domains**
2. Enter your custom domain (e.g., `sasha.moontowermeta.com`)
3. Click "Add"

### 2. Configure DNS

Vercel will show DNS instructions. Add a CNAME record at your DNS provider:

```
Type: CNAME
Name: sasha (or your subdomain)
Value: cname.vercel-dns.com (or the specific value Vercel provides)
```

### 3. Verify Domain

Also add the TXT verification record:

```
Type: TXT
Name: _vercel
Value: vc-domain-verify=... (provided by Vercel)
```

**DNS Propagation:** Usually takes 5-60 minutes.

### 4. Multiple Projects from One Repo

You can create multiple Vercel projects from the same GitHub repo:
- Each project can deploy from a different branch
- Each has independent domains and environment variables
- Perfect for hosting multiple apps in one monorepo

---

## Key Learnings

### 1. Voting Flow Design

**Initial Approach (Changed):**
- Save votes immediately on click
- Store session in localStorage
- Show cumulative counts while voting

**Final Approach (Better UX):**
- Local state until submission
- Fresh session every visit
- Submit button to finalize votes
- Results shown after submission

**Why?** Clearer user journey, prevents accidental votes, feels more intentional.

### 2. Database Design Choices

**Option A: Denormalized (likes_count column)**
- Pros: Fast reads, single query
- Cons: Requires triggers, can get out of sync

**Option B: Calculated Counts (what we used)**
- Pros: Always accurate, no trigger complexity
- Cons: Slightly more queries

**Decision:** We chose Option B for reliability over micro-optimization.

### 3. Session Management

Using `crypto.randomUUID()` for session IDs:
- No auth required
- Each submission generates new ID
- Prevents double-voting in same session
- Allows multiple votes across sessions

### 4. Real-time Updates

Supabase provides real-time subscriptions, but we removed them because:
- Users should see results only after submitting
- Prevents live vote counts during voting phase
- Simpler mental model

### 5. Design System

Using Moontower Mathematical Curves palette:
- **Parchment White** (#F6F4EE) - Background
- **Deep Navy** (#182B40) - Text
- **Electric Cyan** (#00C4E7) - Primary/accents
- **Graph Gray** (#CFCFCF) - Borders

Fonts:
- **Space Grotesk** - Headings
- **Inter** - Body text
- **JetBrains Mono** - Numbers/data

### 6. Git Workflow

**Branch Strategy:**
- Feature branch: `terragon/feature-vote-50-things-ubrlcx`
- Merged to `main` for production deployment
- Main branch = production domain

**Vercel Auto-Deploy:**
- Every push to `main` triggers deployment
- Preview deployments for PRs
- Instant rollback capability

### 7. TypeScript Benefits

Type safety caught several bugs:
- UUID vs integer IDs
- Column name mismatches (`text` vs `label`)
- Optional vs required fields

### 8. Performance Considerations

**Chart Library Choice:**
Recharts was already in the project and works well for:
- Responsive layouts
- Interactive tooltips
- Custom styling

**Optimization Opportunities:**
- Code splitting (chart library is large)
- Image optimization
- Database query batching

---

## Project Structure

```
/root/repo/
├── src/
│   ├── lib/
│   │   └── supabase.ts          # Supabase client & types
│   ├── App.tsx                   # Main voting app
│   ├── index.css                 # Moontower design system
│   └── main.tsx                  # React entry point
├── .env.local                    # Environment variables (gitignored)
├── .gitignore                    # Git ignore rules
├── package.json                  # Dependencies
├── tsconfig.json                 # TypeScript config
├── vite.config.ts                # Vite configuration
└── tailwind.config.js            # Tailwind CSS config
```

---

## Useful Commands

### Development
```bash
npm run dev          # Start dev server
npm run build        # Build for production
npm run preview      # Preview production build
```

### Git
```bash
git status           # Check current state
git add -A           # Stage all changes
git commit -m "..."  # Commit with message
git push             # Push to remote
```

### Supabase SQL
```sql
-- View all votes
SELECT * FROM likes;

-- Count votes per item
SELECT item_id, COUNT(*)
FROM likes
GROUP BY item_id
ORDER BY COUNT(*) DESC;

-- Count unique voters
SELECT COUNT(DISTINCT session_id) FROM likes;

-- Reset everything
DELETE FROM likes;
UPDATE items SET likes_count = 0;
```

---

## Troubleshooting

### Issue: Vote counts always show 0
**Solution:** Calculate counts dynamically from `likes` table instead of relying on `likes_count` column.

### Issue: Domain not working
**Solution:**
1. Check DNS records are correct
2. Wait for DNS propagation (up to 60 minutes)
3. Verify CNAME and TXT records both added

### Issue: Environment variables not working
**Solution:**
1. Prefix with `VITE_` for Vite to expose them
2. Add to Vercel project settings
3. Redeploy after adding variables

### Issue: Build fails on Vercel
**Solution:**
1. Check build logs for TypeScript errors
2. Ensure all dependencies in `package.json`
3. Test build locally: `npm run build`

### Issue: Items not showing on deployed site
**Solution:**
1. Check column name matches (`label` not `text`)
2. Verify Supabase credentials in Vercel
3. Check browser console for errors

---

## Next Steps & Enhancements

### Potential Features
- Export results to CSV
- Social sharing buttons
- Vote history visualization over time
- Anonymous comments on items
- Admin dashboard
- Vote by date ranges
- Comparison views (demographics, time periods)

### Performance Improvements
- Code splitting
- Lazy load chart library
- Database query optimization
- CDN caching strategies

### Analytics
- Track voting patterns
- Session duration
- Most popular items over time
- Geographic distribution (with IP)

---

## Resources

- **Vite Documentation:** https://vitejs.dev
- **React Documentation:** https://react.dev
- **Supabase Documentation:** https://supabase.com/docs
- **Vercel Documentation:** https://vercel.com/docs
- **Recharts Documentation:** https://recharts.org
- **Tailwind CSS:** https://tailwindcss.com
- **Original Essay:** https://sashachapin.substack.com/p/50-things-i-know

---

## Conclusion

This project demonstrates building a full-stack application with:
- Modern frontend tooling (Vite, React, TypeScript)
- Backend-as-a-Service (Supabase)
- Serverless deployment (Vercel)
- Custom domain configuration
- Real-time data visualization

The key to success was iterative development, user-focused design decisions, and choosing the right tools for the job.

---

**Built with [Claude Code](https://claude.com/claude-code)**

*Tutorial generated: 2025-11-02*
