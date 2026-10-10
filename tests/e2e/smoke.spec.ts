import { expect, test } from '@playwright/test';

// Runs against preview mode (no Supabase credentials): public browsing works,
// account features explain that they are not connected yet.

test('homepage renders the hero, sample listings and working calls to action', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Connecting loving homes');
  await expect(page.locator('.pet-card')).toHaveCount(4);
  await expect(page.locator('.product-card')).toHaveCount(4);
  await expect(page.locator('.sample-notice').first()).toBeVisible();

  await page.getByRole('link', { name: /Find My Paw-fect Match/ }).first().click();
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

test('shop search filters the catalog and sample items cannot be added to the cart', async ({ page }) => {
  await page.goto('/shop');
  await expect(page.locator('.product-card')).toHaveCount(6);
  await page.getByRole('searchbox', { name: 'Search products' }).fill('harness');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.locator('.add-button').first()).toBeDisabled();
});

test('the matchmaking quiz returns calculated results and hides excluded pets', async ({ page }) => {
  await page.goto('/match');
  for (let step = 0; step < 3; step++) await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Find my matches' }).click();
  await expect(page.locator('.match-card').first()).toBeVisible();
  const scores = await page.locator('.match-score').allTextContents();
  expect(scores.length).toBeGreaterThan(0);
  for (const score of scores) expect(score).toMatch(/^(\d{1,3}% match|Staff review)$/);
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
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByText('Use at least 10 characters.')).toBeVisible();
});
