require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function generateAIContentGemini(title, prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelsToTry = [
        'gemini-2.5-flash-lite',
        'gemini-flash-latest',
        'gemini-3.1-flash-lite-preview',
        'gemini-2.5-flash',
        'gemini-2.0-flash'
    ];
    let text = '';
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            console.log(`Trying ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            text = response.text();
            if (text) {
                console.log(`Success with ${modelName}!`);
                break;
            }
        } catch (err) {
            console.error(`Error with ${modelName}: ${err.message}`);
            lastError = err;
            continue;
        }
    }
    return text;
}

const title = "Beberapa stesen minyak di Johor alami gangguan bekalan diesel";
const prompt = `Buat ulasan ringkas untuk artikel bertajuk "${title}".
Tolong berikan balasan dalam format JSON ini HANYA (jangan tulis markdown \`\`\`json, hanya kod JSON murni):
{
  "sinopsis": "ringkasan ringkas artikel dalam 2-3 ayat (jangan gunakan tanda bintang atau format tebal)",
  "pengajaran": "satu pengajaran moral ringkas dari artikel ini (jangan gunakan tanda bintang)"
}`;

generateAIContentGemini(title, prompt).then(console.log).catch(console.error);
