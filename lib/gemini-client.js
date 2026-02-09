const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash:generateContent';

let apiKey = null;
let lastQuotaExceededTime = null;
let quotaCooldownMs = 60000; // 1 minute cooldown after quota exceeded

function setApiKey(key) {
    apiKey = key;
}

function getApiKey() {
    return apiKey;
}

function isApiKeySet() {
    return apiKey !== null && apiKey !== undefined && apiKey.length > 0;
}

function isQuotaExceeded() {
    if (!lastQuotaExceededTime) {
        return false;
    }
    
    const timeSinceQuotaError = Date.now() - lastQuotaExceededTime;
    return timeSinceQuotaError < quotaCooldownMs;
}

function getRemainingCooldown() {
    if (!lastQuotaExceededTime) {
        return 0;
    }
    
    const timeSinceQuotaError = Date.now() - lastQuotaExceededTime;
    const remaining = quotaCooldownMs - timeSinceQuotaError;
    return remaining > 0 ? remaining : 0;
}

async function testConnection(key) {
    const testUrl = GEMINI_API_URL + '?key=' + key;

    const response = await fetch(testUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{
                    text: 'Reply with OK'
                }]
            }]
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'API connection failed');
    }

    return true;
}

async function analyzeLandmarks(landmarkData, attentionScore, attentionLevel, poseData) {
    if (!apiKey) {
        throw new Error('API key not configured');
    }

    // Check if quota cooldown is active
    if (isQuotaExceeded()) {
        const remainingSeconds = Math.ceil(getRemainingCooldown() / 1000);
        const error = new Error('Quota exceeded - cooldown active. Please wait ' + remainingSeconds + ' seconds.');
        error.isQuotaError = true;
        error.retryAfter = remainingSeconds;
        throw error;
    }

    const prompt = 'Analyze this facial and pose landmark data to assess attention state.\n\n' +
        'Based on the landmark positions and metrics:\n' +
        '1. Describe the person\'s apparent attention state in 1-2 sentences\n' +
        '2. Note which specific metrics indicate their focus level (head position, eye position, body alignment)\n' +
        '3. If attention is low, suggest one specific action they could take to improve focus\n\n' +
        'The automated system detected an attention score of ' + attentionScore + ' (' + attentionLevel + ').\n\n' +
        'Landmark Data:\n' + JSON.stringify(landmarkData, null, 2) + '\n\n' +
        (poseData ? 'Pose Data:\n' + JSON.stringify(poseData, null, 2) + '\n\n' : '') +
        'Keep your response brief, practical, and actionable. Do not use emojis.';

    const requestBody = {
        contents: [{
            parts: [{
                text: prompt
            }]
        }]
    };

    const response = await fetch(GEMINI_API_URL + '?key=' + apiKey, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const error = await response.json();
        const errorMessage = error.error?.message || 'Gemini API request failed';
        
        // Check if this is a quota error (429)
        if (response.status === 429 || errorMessage.includes('quota') || errorMessage.includes('Quota exceeded')) {
            lastQuotaExceededTime = Date.now();
            console.warn('⚠️ Quota exceeded! Cooldown activated for 60 seconds.');
            
            const quotaError = new Error(errorMessage);
            quotaError.isQuotaError = true;
            quotaError.retryAfter = 60;
            throw quotaError;
        }
        
        throw new Error(errorMessage);
    }

    const data = await response.json();

    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        return data.candidates[0].content.parts[0].text;
    }

    throw new Error('Unexpected response format from Gemini API');
}

async function analyzeImage(imageBase64, attentionScore, attentionLevel) {
    if (!apiKey) {
        throw new Error('API key not configured');
    }

    // Check if quota cooldown is active
    if (isQuotaExceeded()) {
        const remainingSeconds = Math.ceil(getRemainingCooldown() / 1000);
        const error = new Error('Quota exceeded - cooldown active. Please wait ' + remainingSeconds + ' seconds.');
        error.isQuotaError = true;
        error.retryAfter = remainingSeconds;
        throw error;
    }

    const prompt = 'Analyze this image of a person. Based on their posture, facial expression, and body language:\n\n' +
        '1. Describe their apparent attention state in 1-2 sentences\n' +
        '2. Note any specific indicators you observe such as eye direction, posture, or head position\n' +
        '3. If attention seems low, suggest one specific action they could take to improve focus\n\n' +
        'The automated system detected an attention score of ' + attentionScore + ' (' + attentionLevel + ').\n\n' +
        'Keep your response brief, practical, and actionable. Do not use emojis.';

    const requestBody = {
        contents: [{
            parts: [
                {
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: imageBase64
                    }
                },
                {
                    text: prompt
                }
            ]
        }]
    };

    const response = await fetch(GEMINI_API_URL + '?key=' + apiKey, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const error = await response.json();
        const errorMessage = error.error?.message || 'Gemini API request failed';
        
        // Check if this is a quota error (429)
        if (response.status === 429 || errorMessage.includes('quota') || errorMessage.includes('Quota exceeded')) {
            lastQuotaExceededTime = Date.now();
            console.warn('⚠️ Quota exceeded! Cooldown activated for 60 seconds.');
            
            const quotaError = new Error(errorMessage);
            quotaError.isQuotaError = true;
            quotaError.retryAfter = 60;
            throw quotaError;
        }
        
        throw new Error(errorMessage);
    }

    const data = await response.json();

    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        return data.candidates[0].content.parts[0].text;
    }

    throw new Error('Unexpected response format from Gemini API');
}

/**
 * Extract attention confidence score from Gemini response text
 * Looks for numerical patterns in the response
 * @param {string} geminiText - Raw response from Gemini
 * @returns {number} Attention confidence score (0-1)
 */
function extractAttentionConfidence(geminiText) {
    if (!geminiText || typeof geminiText !== 'string') {
        console.warn('⚠️ Invalid Gemini response for confidence extraction');
        return 0.5; // Default to medium confidence
    }

    // Look for percentage patterns (e.g., "75%", "attention at 80%")
    const percentMatch = geminiText.match(/(\d+)\s*%/);
    if (percentMatch) {
        const percentage = parseInt(percentMatch[1]);
        const score = Math.min(100, Math.max(0, percentage)) / 100;
        console.log('📊 Extracted attention confidence from %:', score);
        return score;
    }

    // Look for decimal patterns (e.g., "0.75", "score of 0.8")
    const decimalMatch = geminiText.match(/(?:score|confidence|attention)[^0-9]*(\d\.?\d*)|(\d\.?\d*)/i);
    if (decimalMatch) {
        const value = parseFloat(decimalMatch[1] || decimalMatch[2]);
        if (value >= 0 && value <= 1) {
            console.log('📊 Extracted attention confidence from decimal:', value);
            return value;
        } else if (value > 1 && value <= 100) {
            const score = value / 100;
            console.log('📊 Extracted attention confidence from 0-100:', score);
            return score;
        }
    }

    // Look for keywords indicating attention level
    const lowerText = geminiText.toLowerCase();
    
    if (lowerText.includes('very high') || lowerText.includes('excellent focus')) {
        return 0.9;
    } else if (lowerText.includes('high') || lowerText.includes('good focus')) {
        return 0.8;
    } else if (lowerText.includes('medium') || lowerText.includes('moderate') || lowerText.includes('adequate')) {
        return 0.6;
    } else if (lowerText.includes('low') || lowerText.includes('poor') || lowerText.includes('distracted')) {
        return 0.4;
    } else if (lowerText.includes('very low') || lowerText.includes('extremely low') || lowerText.includes('not focused')) {
        return 0.2;
    }

    // Default fallback - return middle value
    console.log('⚠️ Could not extract confidence score, using default 0.5');
    return 0.5;
}

export {
    setApiKey,
    getApiKey,
    isApiKeySet,
    testConnection,
    analyzeLandmarks,
    analyzeImage,
    isQuotaExceeded,
    getRemainingCooldown,
    extractAttentionConfidence
};

