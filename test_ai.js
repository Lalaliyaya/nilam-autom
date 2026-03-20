require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function test() {
    console.log('Testing Gemini API key...');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const models = [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.0-flash-lite',
        'gemini-flash-latest',
        'gemini-3.1-flash-lite-preview'
    ];

    for (const modelName of models) {
        try {
            console.log(`Trying ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent('Hi');
            console.log(`${modelName} works!`);
            // If one works, we are good.
        } catch (e) {
            console.error(`${modelName} failed:`, e.message);
        }
    }
}
test();
