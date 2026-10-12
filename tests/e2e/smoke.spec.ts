import { expect, test } from '@playwright/test';

// Dedicated unconfigured servers: no browser test can write to the live project.

test('homepage renders honest unavailable states and working calls to action', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/', {waitUntil:'domcontentloaded'});
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Give a shelter pet');
  await expect(page.locator('.pet-card')).toHaveCount(0);
  await expect(page.locator('.product-card')).toHaveCount(0);
  await expect(page.getByText('Connect Supabase to enable accounts, saved records, and transactions.').first()).toBeVisible();

  await page.getByRole('link', { name: /Find my match/ }).first().click();
  await expect(page).toHaveURL(/\/match$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('paw-fect match');
  expect(errors).toEqual([]);
});

test('every primary route renders its own heading without horizontal overflow', async ({ page }) => {
  for (const path of ['/shop', '/adopt', '/match', '/rescue', '/transport', '/donate', '/volunteer', '/about', '/contact', '/cart', '/privacy', '/terms']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} overflows horizontally`).toBeLessThanOrEqual(0);
  }
});

test('shop distinguishes unavailable data from empty data and supports retry', async ({ page }) => {
  await page.goto('/shop');
  await expect(page.getByRole('button', {name:'Try again'}).first()).toBeVisible();
  await page.route('**/api/products?**', route => route.fulfill({json:{data:[],meta:{page:1,limit:12,total:0}}}));
  await page.getByRole('searchbox', { name: 'Search products' }).fill('harness');
  await expect(page.locator('.product-card')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'No matches just yet'})).toBeVisible();
});

test('the matchmaking quiz never invents results when the database is unavailable', async ({ page }) => {
  await page.goto('/match');
  for (let step = 0; step < 3; step++) await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Find my matches' }).click();
  await expect(page.getByRole('alert')).toContainText('Connect Supabase');
  await expect(page.locator('.match-card')).toHaveCount(0);
});

test('account pages require sign-in and unknown routes show a not-found page', async ({ page }) => {
  await page.goto('/account');
  await expect(page.getByRole('link', { name: /Sign in to your account/ })).toBeVisible();
  await page.goto('/admin');
  await expect(page.getByText('available to authorized shelter personnel')).toBeVisible();
  await page.goto('/definitely-not-a-page');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('wandered off');
});

test('registration validates input before contacting the server', async ({ page }) => {
  await page.goto('/auth/register');
  await page.getByLabel('Full name').fill('Test Person');
  await page.getByLabel('Email address').fill('test.person@example.test');
  await page.getByLabel('Password', {exact:true}).fill('short');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByText('Use at least 10 characters.')).toBeVisible();
});
