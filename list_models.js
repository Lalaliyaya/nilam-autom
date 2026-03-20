require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
    console.log('Listing available models...');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    try {
        const models = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`)
            .then(res => res.json());
        console.log(JSON.stringify(models, null, 2));
    } catch (e) {
        console.error('List models failed:', e.message);
    }
}
listModels();
