// test-monday-connection.js - FIXED to properly retrieve item values
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    const mondayApiKey = process.env.MONDAY_API_KEY;
    const mondayBoardId = process.env.MONDAY_BOARD_ID;
    
    console.log('🔍 Testing Monday.com connection...');
    console.log('Board ID:', mondayBoardId);
    console.log('API Key present:', !!mondayApiKey);
    
    if (!mondayApiKey || !mondayBoardId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Missing credentials',
          hasApiKey: !!mondayApiKey,
          hasBoardId: !!mondayBoardId
        })
      };
    }
    
    // Test 1: Basic API connectivity
    console.log('📋 Test 1: Basic API connectivity...');
    const basicQuery = `
      query {
        me {
          name
          email
        }
      }
    `;
    
    const basicResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: basicQuery })
    });
    
    const basicResult = await basicResponse.json();
    console.log('Basic API result:', basicResult);
    
    // Test 2: Board access with columns
    console.log('📋 Test 2: Board access...');
    const boardQuery = `
      query {
        boards(ids: [${mondayBoardId}]) {
          id
          name
          columns {
            id
            title
            type
          }
        }
      }
    `;
    
    const boardResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: boardQuery })
    });
    
    const boardResult = await boardResponse.json();
    console.log('Board access result:', boardResult);
    
    // Test 3: CORRECTED - Get all items and search through them for job 13997
    console.log('📋 Test 3: CORRECTED - Getting all items and searching for job 13997...');
    const searchQuery = `
      query {
        boards(ids: [${mondayBoardId}]) {
          items_page(limit: 100) {
            items {
              id
              name
              column_values(ids: ["text7"]) {
                id
                text
                value
              }
            }
          }
        }
      }
    `;
    
    const searchResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: searchQuery })
    });
    
    const searchResult = await searchResponse.json();
    console.log('FIXED search result:', JSON.stringify(searchResult, null, 2));
    
    // Test 4: ADDITIONAL - Get first 10 items to see what values actually exist
    console.log('📋 Test 4: ADDITIONAL - Getting first 10 items to see actual text7 values...');
    const itemsQuery = `
      query {
        boards(ids: [${mondayBoardId}]) {
          items_page(limit: 10) {
            items {
              id
              name
              column_values(ids: ["text7"]) {
                id
                text
                value
              }
            }
          }
        }
      }
    `;
    
    const itemsResponse = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayApiKey
      },
      body: JSON.stringify({ query: itemsQuery })
    });
    
    const itemsResult = await itemsResponse.json();
    console.log('Sample items result:', JSON.stringify(itemsResult, null, 2));
    
    // Parse results
    const foundJob = searchResult.data?.items_by_column_values?.length > 0 ? searchResult.data.items_by_column_values[0] : null;
    
    const sampleItems = itemsResult.data?.boards?.[0]?.items_page?.items || [];
    const itemsWithText7Values = sampleItems.map(item => {
      const text7Column = item.column_values.find(col => col.id === 'text7');
      return {
        id: item.id,
        name: item.name,
        text7Value: text7Column?.text || 'EMPTY',
        text7Raw: text7Column?.value || 'NULL'
      };
    });
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        tests: {
          basicApi: {
            success: !basicResult.errors,
            user: basicResult.data?.me,
            errors: basicResult.errors
          },
          boardAccess: {
            success: !boardResult.errors,
            board: boardResult.data?.boards?.[0],
            errors: boardResult.errors
          },
          jobSearchCorrected: {
            success: !searchResult.errors,
            foundJob13997: !!foundJob,
            jobDetails: foundJob,
            searchErrors: searchResult.errors,
            totalItemsSearched: allText7Values.length,
            allText7Values: allText7Values
          },
          sampleItems: {
            success: !itemsResult.errors,
            totalSampled: itemsWithText7Values.length,
            itemsWithText7: itemsWithText7Values,
            errors: itemsResult.errors
          }
        },
        analysis: {
          mondayConnection: !basicResult.errors && !boardResult.errors,
          job13997Found: !!foundJob,
          text7ColumnExists: !!boardResult.data?.boards?.[0]?.columns?.find(col => col.id === 'text7'),
          sampleText7Values: itemsWithText7Values.map(item => item.text7Value).filter(val => val !== 'EMPTY')
        },
        recommendations: foundJob ? 
          ['✅ Monday.com connection working!', '✅ Job 13997 FOUND!', '🔧 Ready to fix the webhook integration'] :
          ['✅ Monday.com connection working', '❌ Job 13997 not found in text7 column', `🔍 Found these text7 values instead: ${itemsWithText7Values.map(item => item.text7Value).filter(val => val !== 'EMPTY').join(', ')}`]
      })
    };
    
  } catch (error) {
    console.error('❌ Test error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Test failed', 
        details: error.message 
      })
    };
  }
};
