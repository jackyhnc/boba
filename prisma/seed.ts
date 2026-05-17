// Seed script — populate a fresh database with a handful of fake users
// for local development.
//
// Run with: `npm run seed` (uses `tsx prisma/seed.ts`).
//
// Idempotent: re-running upserts by phone, so this is safe in a dev loop.
// Pure local data — no network calls, no Anthropic, no Twilio.

/* eslint-disable no-console */

import { PrismaClient, type Gender } from "@prisma/client";

const prisma = new PrismaClient();

interface SeedUser {
  phone: string;
  displayName: string;
  age: number;
  gender: Gender;
  profession: string;
  heightCm: number;
  preferredGenders: Gender[];
  minAge: number;
  maxAge: number;
  typeDescriptor: string;
  campusEmailDomain: string;
  isAiBacked?: boolean;
  aiPersonaPrompt?: string;
}

const SEED_USERS: SeedUser[] = [
  {
    phone: "+15550000001",
    displayName: "Alice",
    age: 22,
    gender: "WOMAN",
    profession: "physics student",
    heightCm: 168,
    preferredGenders: ["MAN", "NONBINARY"],
    minAge: 21,
    maxAge: 28,
    typeDescriptor:
      "Curious, low-key, loves long walks and Dostoevsky.",
    campusEmailDomain: "princeton.edu",
  },
  {
    phone: "+15550000002",
    displayName: "Ben",
    age: 24,
    gender: "MAN",
    profession: "software engineer",
    heightCm: 182,
    preferredGenders: ["WOMAN"],
    minAge: 21,
    maxAge: 30,
    typeDescriptor:
      "Looking for someone thoughtful — bonus points if you read fiction.",
    campusEmailDomain: "princeton.edu",
  },
  {
    phone: "+15550000003",
    displayName: "Cam",
    age: 23,
    gender: "NONBINARY",
    profession: "design student",
    heightCm: 175,
    preferredGenders: ["WOMAN", "NONBINARY"],
    minAge: 21,
    maxAge: 27,
    typeDescriptor:
      "Big into ceramics, indie folk, and Friday-night ramen.",
    campusEmailDomain: "princeton.edu",
  },
  {
    phone: "+15550000004",
    displayName: "Dani",
    age: 25,
    gender: "WOMAN",
    profession: "phd student in math",
    heightCm: 170,
    preferredGenders: ["MAN", "WOMAN"],
    minAge: 22,
    maxAge: 32,
    typeDescriptor:
      "Quiet, intense, the kind of person who texts you a proof at 1am.",
    campusEmailDomain: "princeton.edu",
  },
  {
    phone: "+15550000005",
    displayName: "Evan",
    age: 26,
    gender: "MAN",
    profession: "law student",
    heightCm: 178,
    preferredGenders: ["WOMAN"],
    minAge: 22,
    maxAge: 30,
    typeDescriptor: "Witty over substantive, but I'm trying.",
    campusEmailDomain: "princeton.edu",
  },
  {
    phone: "+15550000006",
    displayName: "Fae",
    age: 22,
    gender: "WOMAN",
    profession: "ceramicist",
    heightCm: 165,
    preferredGenders: ["WOMAN", "NONBINARY"],
    minAge: 20,
    maxAge: 28,
    typeDescriptor:
      "Slow conversations, weird hobbies, soft hands welcome.",
    campusEmailDomain: "princeton.edu",
  },
  // One AI-backed user for the cold-start scenario. AI seeding is
  // disabled by default at the env level — this row exists only so the
  // matching flow has something to assign during demos.
  {
    phone: "+15550000099",
    displayName: "Robin",
    age: 23,
    gender: "WOMAN",
    profession: "grad student",
    heightCm: 167,
    preferredGenders: ["MAN", "NONBINARY", "WOMAN"],
    minAge: 19,
    maxAge: 35,
    typeDescriptor: "Curious about everything. Asks better questions than I answer.",
    campusEmailDomain: "princeton.edu",
    isAiBacked: true,
    aiPersonaPrompt:
      "You are Robin, a 23-year-old grad student. Warm, curious, you ask thoughtful questions about whatever the other person is into. You're funny but not performative.",
  },
];

async function upsertUser(u: SeedUser): Promise<void> {
  const user = await prisma.user.upsert({
    where: { phone: u.phone },
    create: {
      phone: u.phone,
      displayName: u.displayName,
      campusEmailDomain: u.campusEmailDomain,
      status: "ACTIVE",
      isAiBacked: u.isAiBacked ?? false,
      aiPersonaPrompt: u.aiPersonaPrompt ?? null,
    },
    update: {
      displayName: u.displayName,
      campusEmailDomain: u.campusEmailDomain,
      status: "ACTIVE",
      onboardingStep: null,
      isAiBacked: u.isAiBacked ?? false,
      aiPersonaPrompt: u.aiPersonaPrompt ?? null,
    },
  });

  await prisma.stats.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      age: u.age,
      gender: u.gender,
      profession: u.profession,
      heightCm: u.heightCm,
    },
    update: {
      age: u.age,
      gender: u.gender,
      profession: u.profession,
      heightCm: u.heightCm,
    },
  });

  await prisma.preferences.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      preferredGenders: u.preferredGenders,
      minAge: u.minAge,
      maxAge: u.maxAge,
      typeDescriptor: u.typeDescriptor,
    },
    update: {
      preferredGenders: u.preferredGenders,
      minAge: u.minAge,
      maxAge: u.maxAge,
      typeDescriptor: u.typeDescriptor,
    },
  });
}

async function main(): Promise<void> {
  console.log(`seeding ${SEED_USERS.length} users…`);
  for (const u of SEED_USERS) {
    await upsertUser(u);
    console.log(`  ✓ ${u.displayName} (${u.phone})`);
  }
  console.log("done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
