const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

(async () => {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    
    console.log('Logging in...');
    await page.goto('https://ains.moe.gov.my/', { waitUntil: 'networkidle2' });
    
    // Login flow
    // ... we assume the user's .env has the right credentials
    const email = process.env.DELIMA_EMAIL;
    const password = process.env.DELIMA_PASSWORD;
    
    // Click login
    const loginBtn = await page.$('a[href*="login"], button.btn-login');
    if (loginBtn) await loginBtn.click();
    await new Promise(r => setTimeout(r, 5000));
    
    // If Google login
    if (page.url().includes('google.com')) {
        await page.type('input[type="email"]', email);
        await page.click('#identifierNext');
        await new Promise(r => setTimeout(r, 5000));
        await page.type('input[type="password"]', password);
        await page.click('#passwordNext');
        await new Promise(r => setTimeout(r, 10000));
    }
    
    console.log('Dashboard reached: ' + page.url());
    await page.screenshot({ path: 'dashboard_inspect.png' });
    const html = await page.content();
    fs.writeFileSync('dashboard_inspect.html', html);
    
    // List all buttons
    const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, a, [role="button"]')).map(el => ({
            text: el.innerText || el.textContent,
            tag: el.tagName,
            classes: el.className,
            id: el.id
        }));
    });
    console.log(JSON.stringify(buttons, null, 2));
    
    await browser.close();
})();
