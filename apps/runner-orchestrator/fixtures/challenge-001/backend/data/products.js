// backend/data/products.js

const INITIAL_PRODUCTS = [
  {
    id: "1",
    name: "Mechanical Keyboard",
    price: 120,
    tags: ["gaming", "hardware", "peripherals"],
  },
  {
    id: "2",
    name: "Gaming Mouse",
    price: 60,
    tags: ["gaming", "accessories", "usb"],
  },
  {
    id: "3",
    name: "Monitor Arm",
    price: 45,
    tags: ["desk", "office", "ergonomic"],
  },
];

let nextId = 4;
let products = JSON.parse(JSON.stringify(INITIAL_PRODUCTS));

function getAll() {
  return products;
}

function findById(id) {
  return products.find((p) => p.id === String(id));
}

function add(product) {
  const created = {
    id: String(nextId++),
    name: product.name,
    price: product.price,
    tags: product.tags,
  };

  products.push(created);
  return created;
}

function deleteById(id) {
  const index = products.findIndex((p) => p.id === String(id));
  if (index === -1) {
    return false;
  }
  products.splice(index, 1);
  return true;
}

function deleteAll() {
  products.length = 0;
}

function reset() {
  products = JSON.parse(JSON.stringify(INITIAL_PRODUCTS));
  nextId = 4;
}

module.exports = {
  getAll,
  findById,
  add,
  deleteById,
  deleteAll,
  reset,
};
