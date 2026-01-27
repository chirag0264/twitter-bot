// Port of the n8n Parse Response1 node logic

interface GrokParsed {
  results: any[];
  breaking: any[];
  count: number;
  breakingCount: number;
  timestamp: string;
}

export function parseGrokResponse(raw: any): GrokParsed {
  const now = new Date().toISOString();
  let parsedArray: any[] = [];

  try {
    let content = '';

    if (Array.isArray(raw) && raw[0]?.text) {
      content = raw[0].text;
    } else if (raw.text) {
      content = raw.text;
    } else if (raw.response?.generations?.[0]?.[0]?.text) {
      content = raw.response.generations[0][0].text;
    } else if (raw.choices && raw.choices[0]) {
      content =
        raw.choices[0].message?.content || raw.choices[0].text || '';
    } else if (raw.content) {
      content = raw.content;
    } else if (typeof raw === 'string') {
      content = raw;
    } else if (Array.isArray(raw)) {
      parsedArray = raw;
    }

    if (parsedArray.length === 0 && content) {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        parsedArray = JSON.parse(jsonMatch[0]);
      } else {
        const parsed = JSON.parse(content);
        parsedArray = Array.isArray(parsed) ? parsed : [parsed];
      }
    }

    if (!Array.isArray(parsedArray)) {
      throw new Error('Response is not an array');
    }

    const allBreaking: any[] = [];
    for (let i = 0; i < parsedArray.length; i++) {
      const item = parsedArray[i];
      if (
        item?.breaking &&
        Array.isArray(item.breaking) &&
        item.breaking.length > 0
      ) {
        allBreaking.push(...item.breaking);
      }
    }

    console.log(
      `✅ Parsed ${parsedArray.length} items, ${allBreaking.length} breaking`
    );

    return {
      results: parsedArray,
      breaking: allBreaking,
      count: parsedArray.length,
      breakingCount: allBreaking.length,
      timestamp: now,
    };
  } catch (err: any) {
    console.log('❌ Parse error:', err.message);
    return {
      results: [],
      breaking: [],
      count: 0,
      breakingCount: 0,
      timestamp: now,
    };
  }
}

