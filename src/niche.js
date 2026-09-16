/**
 * THE NICHE: general popular content.
 *
 * Broad-appeal short-form video that works on Instagram Reels, TikTok and
 * YouTube Shorts without any subject-matter expertise: surprising facts,
 * psychology, money/life hacks, "things you didn't know", history bites,
 * science-in-30-seconds, internet culture explainers.
 *
 * Skill 01 (the researcher) uses `seedAccounts` and `hashtags` as its shopping
 * list. Everything downstream is niche-agnostic: swap this file to re-point the
 * whole machine at a different niche.
 */

export const NICHE = {
  id: 'general-popular',
  name: 'General Popular Content',

  /** One paragraph. Fed to the copywriter as the brand brief. */
  brief: [
    'Broad-appeal "scroll-stopping facts and insights" content for a general',
    'audience aged 16-45. No niche jargon, no prerequisites. Every video teaches',
    'one surprising thing a normal person can repeat to a friend that evening.',
    'Think: the interesting-facts corner of the internet, not a guru account.',
  ].join(' '),

  /** Voice rules handed to Skill 02 verbatim. */
  voice: {
    persona: 'A curious friend who reads too much and explains things fast.',
    rules: [
      'Second person. Talk to one viewer, never "you guys".',
      'Short sentences. Average under 12 words.',
      'Concrete nouns and real numbers over adjectives.',
      'No emoji in the voiceover. Max one in the caption.',
      'No "in this video", no "let me explain", no throat-clearing.',
      'Never open with a greeting. The first four words are the hook.',
      'No hashtag stuffing inside the script body.',
      'Plain language: if a 14-year-old would not know the word, swap it.',
    ],
    banned_phrases: [
      'in today\'s video', 'without further ado', 'buckle up', 'game changer',
      'let that sink in', 'stay tuned', 'hit that follow button', 'crazy right',
      'mind blown', 'as we all know', 'in conclusion',
    ],
  },

  /**
   * Content pillars. The copywriter tags every script with one so the schedule
   * can be balanced instead of drifting into a single format.
   */
  pillars: [
    { id: 'did-you-know',   label: 'Surprising facts',        weight: 3 },
    { id: 'how-things-work',label: 'How things actually work',weight: 2 },
    { id: 'psychology',     label: 'Human behaviour',         weight: 2 },
    { id: 'money-life',     label: 'Money and life mechanics',weight: 2 },
    { id: 'history-bite',   label: 'History in 30 seconds',   weight: 1 },
    { id: 'internet',       label: 'Internet and pop culture',weight: 1 },
  ],

  /**
   * The "top 50 accounts, any niche" shopping list from Skill 01.
   * These are public accounts in the general-popular space. They are the
   * research input only - the machine reads their public metrics to learn what
   * already performed; it never republishes their media.
   */
  seedAccounts: {
    instagram: [
      'factsdaily', 'science', 'natgeo', 'thefactsdaily', 'wtf.facts',
      'dailyfactsofficial', 'factsweekly', 'amazing.facts', 'curiosity',
      'brightside.me', 'didyouknowfacts', 'factsfun', 'sciencechannel',
      'thedodo', 'unilad', 'ladbible', '9gag', 'interestingengineering',
    ],
    tiktok: [
      'factsverse', 'zackdfilms', 'brightside.official', 'howstuffworks',
      'thedailyfacts', 'science.channel', 'mrballen', 'jordan_the_stallion8',
      'dylan_page', 'therealfactsonly', 'philosophy.bites', 'wowfacts',
    ],
    youtube: [
      '@Zack D. Films', '@BRIGHT SIDE', '@Veritasium', '@SciShow',
      '@TheInfographicsShow', '@BeAmazed', '@RealLifeLore', '@Vsauce',
      '@HowStuffWorks', '@DailyDoseOfInternet',
    ],
  },

  hashtags: {
    /** Seeds for discovery scraping, and a pool the copywriter draws from. */
    core: ['facts', 'didyouknow', 'interestingfacts', 'learnontiktok', 'todayilearned'],
    instagram: ['reels', 'explorepage', 'factsdaily', 'mindblowing', 'curiosity'],
    tiktok: ['fyp', 'foryou', 'learnontiktok', 'edutok', 'factcheck'],
    youtube: ['shorts', 'facts', 'didyouknow', 'education', 'interesting'],
  },

  /** Topics the machine must never produce, whatever the scrape turns up. */
  exclusions: [
    'medical, legal or financial advice framed as instruction',
    'named private individuals',
    'active political campaigns, elections or partisan talking points',
    'conspiracy claims presented as fact',
    'tragedy, gore, self-harm or anything requiring a content warning',
    'unverified statistics with no traceable source',
  ],
};

export default NICHE;
