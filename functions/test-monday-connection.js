// test-monday-connection.js - Simple Monday.com API connection test
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
    
    // Test 2: Board access
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
    
    // Test 3: Search for items (corrected method)
    console.log('📋 Test 3: Searching for job 13997...');
    const searchQuery = `
      query {
        boards(ids: [${mondayBoardId}]) {
          items_page {
            items {
              id
              name
              column_values {
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
    console.log('Search result:', JSON.stringify(searchResult, null, 2));
    
    // Find job 13997 in the results
    let foundJob = null;
    if (searchResult.data?.boards?.[0]?.items_page?.items) {
      const items = searchResult.data.boards[0].items_page.items;
      
      for (const item of items) {
        const jobColumn = item.column_values.find(col => col.id === 'text7');
        if (jobColumn && jobColumn.text === '13997') {
          foundJob = item;
          break;
        }
      }
    }
    
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
          jobSearch: {
            success: !searchResult.errors,
            foundJob13997: !!foundJob,
            jobDetails: foundJob,
            totalItems: searchResult.data?.boards?.[0]?.items_page?.items?.length || 0,
            errors: searchResult.errors
          }
        },
        recommendations: foundJob ? 
          ['✅ Monday.com connection working!', '✅ Job 13997 found!', '🔧 Ready to fix the webhook API call'] :
          ['✅ Monday.com connection working', '❌ Job 13997 not found - check job number in text7 column', '🔍 Check if job exists in board']
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
