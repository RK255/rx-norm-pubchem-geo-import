import { deleteEntity, parseId } from '@geoprotocol/grc-20';

// Test what deleteEntity returns
const testOp = deleteEntity({ 
  id: parseId('3d9249e8-0d4b-0272-a8ee-b733af82a123'), 
  space: parseId('e8173628fb65f0957475a58933040614') 
});

console.log('Test op type:', typeof testOp);
console.log('Test op keys:', Object.keys(testOp));
console.log('Test op.type:', testOp.type);
console.log('Test op.id instanceof Uint8Array:', testOp.id instanceof Uint8Array);
