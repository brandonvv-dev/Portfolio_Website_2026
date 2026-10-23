
# Portfolio Website

> Blazing-fast, 3D-enhanced, mobile-first portfolio with GitHub integration, AI showcase, and interactive animations.

## 🚀 Features

* **3D Animated Hero** - Floating orbs, grid perspective, gradient text reveals
* **Interactive Record Player** - GitHub repos displayed as pullable vinyl records
* **Code Window About Section** - Syntax-highlighted code display with floating stats
* **AI Services Showcase** - Dedicated section for automation & fine-tuning work
* **Real-time GitHub Integration** - Auto-pulls repos (public + private) hourly
* **Smooth Animations** - Glassmorphism, parallax, hover effects - all optimized
* **Mobile-First Design** - Perfect from 320px to 4K displays
* **Zero Lag** - Static generation, <1s load time, 95+ Lighthouse scores

---

## 📁 Project Structure

```
portfolio-website/
├── src/
│   ├── components/
│   │   ├── Hero.astro          # 3D hero with floating orbs
│   │   ├── About.astro         # Code window + timeline
│   │   ├── FeaturedProjects.astro  # Dev + AI projects
│   │   ├── GitHubRepos.astro   # Record player carousel
│   │   └── Contact.astro       # Contact cards + footer
│   ├── data/
│   │   └── projects.ts         # Your project data
│   ├── layouts/
│   │   └── Layout.astro        # Base layout with mesh bg
│   ├── pages/
│   │   └── index.astro         # Main page
│   └── utils/
│       └── github.ts           # GitHub API integration
├── public/
│   └── images/                 # Project screenshots
├── .env                        # GitHub token (DO NOT COMMIT)
└── package.json
```

---

## ⚡ Quick Start (30 minutes)

### 1. Initialize Project

bash

```bash
cd portfolio-website

# Create Astro project
npm create astro@latest . -- --template minimal --install --git --typescript strict

# Add Tailwind & dependencies
npx astro add tailwind
npminstall octokit
```

### 2. Set Up GitHub Token

1. Go to: [https://github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token** → **Fine-grained token**
3. Configure:
   * Name: `Portfolio Website`
   * Expiration: 1 year
   * Repository access: **All repositories**
   * Permissions:
     * Contents: **Read-only**
     * Metadata: **Read-only**
4. Generate and copy token
5. Create `.env` file:

bash

```bash
GITHUB_TOKEN=ghp_your_token_here
GITHUB_USERNAME=brandonvv-dev
```

6. Add to `.gitignore`:

bash

```bash
echo".env">> .gitignore
echo".env.local">> .gitignore
```

### 3. Copy All Code Files

Copy each artifact into the corresponding file:

* `src/layouts/Layout.astro` - Base layout
* `src/components/Hero.astro` - Hero section
* `src/components/About.astro` - About section
* `src/components/FeaturedProjects.astro` - Projects
* `src/components/GitHubRepos.astro` - GitHub carousel
* `src/components/Contact.astro` - Contact & footer
* `src/pages/index.astro` - Main page
* `src/utils/github.ts` - GitHub API
* `src/data/projects.ts` - Project data

### 4. Customize Your Content

#### A. Update `src/data/projects.ts`:

typescript

```typescript
// Replace with your actual projects
{
  title:"Your Real Project Name",
  description:"Brief one-liner",
  longDescription:"Detailed description with impact/results",
  tech:["React","Node.js","etc"],
  github:"https://github.com/brandonvv-dev/repo-name",
  live:"https://your-live-demo.com",
  image:"/images/project1.jpg",
  featured:true,
  category:'dev'// or 'ai'
}
```

#### B. Add Project Images:

bash

```bash
# Compress images first (use squoosh.app or tinypng.com)
# Add to public/images/
public/images/project1.jpg
public/images/project2.jpg
public/images/ai-project.jpg
```

#### C. Update Contact Info in `src/components/Contact.astro`:

* Replace `brandon@example.com` with your email
* Replace social media links (LinkedIn, Twitter)
* Update time zone if not SAST

#### D. Update About Section in `src/components/About.astro`:

* Edit the bio text
* Update stats (years of experience, projects shipped)
* Modify timeline events to match your journey

### 5. Run Development Server

bash

```bash
npm run dev
# Visit http://localhost:4321
```

---

## 🚢 Deploy to Vercel (10 minutes)

### 1. Install Vercel CLI

bash

```bash
npm i -g vercel
```

### 2. Deploy

bash

```bash
vercel
```

Follow prompts:

* Connect to GitHub
* Name your project
* Accept default settings

### 3. Add Environment Variables in Vercel

1. Go to: Vercel Dashboard → Your Project → Settings → Environment Variables
2. Add:
   * `GITHUB_TOKEN` = your token
   * `GITHUB_USERNAME` = brandonvv-dev
3. Redeploy to apply changes

---

## 🎨 Customization Guide

### Change Color Scheme

Edit gradient colors in components:

astro

```astro
<!-- Primary gradient (blue to cyan) -->
bg-linear-to-r from-blue-400 to-cyan-400

<!-- Secondary gradient (purple to pink) -->
bg-linear-to-r from-purple-400 to-pink-400

<!-- Replace with your colors -->
bg-linear-to-r from-YOUR-COLOR to-YOUR-COLOR
```

### Add More Projects

1. Add project data to `src/data/projects.ts`
2. Add image to `public/images/`
3. Deploy - that's it!

### Modify Animations

All animations are in `<style>` blocks:

css

```css
/* Adjust timing */
transition: all 0.3s ease;/* Change 0.3s to speed up/slow down */

/* Adjust transforms */
hover:scale-105  /* Change scale value */
hover:translateY(-8px)/* Adjust hover lift */
```

---

## 📊 Performance Checklist

* [ ] All images compressed (WebP format, <500KB each)
* [ ] Images in `public/images/` directory
* [ ] `.env` file created with GitHub token
* [ ] `.env` added to `.gitignore`
* [ ] Project data updated in `projects.ts`
* [ ] Contact info updated
* [ ] Tested on mobile (Chrome DevTools)
* [ ] GitHub token added to Vercel
* [ ] Domain connected (optional)

---

## 🛠️ Useful Commands

bash

```bash
npm run dev          # Start dev server
npm run build        # Build for production
npm run preview      # Preview production build
vercel               # Deploy to Vercel
vercel --prod        # Deploy to production
```

---

## 🎯 Key Features Explained

### Record Player GitHub Carousel

* Displays repos as vinyl records you can flip through
* Keyboard navigation (arrow keys)
* Shows: stars, forks, language, last updated
* Supports private repos with token
* Auto-updates hourly

### 3D Hero Section

* Floating gradient orbs with parallax
* Perspective grid background
* Animated text reveals
* Glassmorphism badges
* Mobile-optimized (smaller orbs on mobile)

### Code Window About

* Syntax-highlighted "code"
* Floating stat cards
* Interactive timeline
* Skills grid with hover effects

### AI Services Section

* Dedicated showcase for AI/ML work
* Service cards with icons
* Featured case study layout
* Separate from dev projects

---

## 📱 Mobile Optimization

All components are mobile-first:

* Touch-friendly tap targets (min 44px)
* Reduced animations on mobile
* Optimized font sizes
* Hamburger menu (if you add nav)
* Fast loading on 3G networks

---

## 🔒 Security Notes

**IMPORTANT:**

* Never commit `.env` file
* Keep GitHub token private
* Use read-only token permissions
* Rotate token yearly
* Check `.gitignore` before pushing

---

## 🐛 Troubleshooting

**GitHub repos not showing:**

* Check token in `.env`
* Verify token has correct permissions
* Check Vercel environment variables
* Look at browser console for errors

**Slow loading:**

* Compress images more
* Check network tab in DevTools
* Ensure `npm run build` completes

**Animations laggy:**

* Reduce blur values
* Simplify transforms
* Test on target devices

---

## 📚 Tech Stack

* **Astro 4.x** - Static site generator
* **Tailwind CSS** - Utility-first styling
* **TypeScript** - Type safety
* **Octokit** - GitHub API client
* **Vercel** - Hosting & deployment
