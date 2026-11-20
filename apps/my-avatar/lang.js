// Language for My Avatar. On a Duckling tablet set to Spanish (KidTablet.language) every label, prompt, shop item,
// price line and spoken line is Spanish. The dictionary is keyed by the English text that was already in the app,
// with {name} style placeholders kept in both languages, so the English app does not change. Ids, storage keys, the
// shop list, prices and the star accounting are untouched; only what she reads or hears goes through T().
//
// A key may carry a context ("face|Round") where the same English word takes a different Spanish form in two places
// (a round face is redonda, round glasses are redondos). T(s, vars, ctx) looks for ctx|s first, then s.
(function () {
  'use strict';
  const LANG = window.KidTablet && window.KidTablet.language === 'es' ? 'es' : 'en';
  const ES = {
    // Header, stage and the save line
    'My Avatar': 'Mi avatar', '🧍 My Avatar': '🧍 Mi avatar', 'Saved to your home screen ✓': 'Guardado en tu pantalla de inicio ✓', 'to spend': 'para gastar',
    'Buy': 'Comprar', 'Take off': 'Quitar', '🙂 Face': '🙂 Cara', '🧍 Body': '🧍 Cuerpo', 'Getting ready...': 'Preparando...',
    // Categories in the side bar
    'Body': 'Cuerpo', 'Face': 'Cara', 'Eyes': 'Ojos', 'Hair': 'Cabello', 'Clothes': 'Ropa', 'Pose': 'Pose', 'Hats': 'Sombreros',
    'Extras': 'Extras', 'Outfits': 'Disfraces', 'Pets': 'Mascotas', 'Places': 'Lugares', 'Sparkles': 'Brillos', 'My picture': 'Mi foto', 'Colors': 'Colores',
    // Panel titles
    'Skin': 'Piel', 'Height': 'Estatura', 'Build': 'Complexión', 'Face shape': 'Forma de la cara', 'Nose': 'Nariz', 'Mouth': 'Boca',
    'Freckles': 'Pecas', 'Rosy cheeks': 'Mejillas rosadas', 'Eye shape': 'Forma de los ojos', 'Eye color': 'Color de ojos', 'Eyebrows': 'Cejas',
    'Eyelashes': 'Pestañas', 'Glasses': 'Lentes', 'Glasses color': 'Color de los lentes', 'Hair style': 'Peinado', 'Hair color': 'Color de cabello',
    'Fun colors ⭐': 'Colores divertidos ⭐', 'Top': 'Parte de arriba', 'Top color': 'Color de arriba', 'Bottoms': 'Parte de abajo',
    'Bottoms color': 'Color de abajo', 'Shoes': 'Zapatos', 'Shoe color': 'Color de zapatos', 'Top or dress': 'Parte de arriba o vestido',
    'Socks': 'Calcetines', 'Earrings': 'Aretes', 'I am a': 'Soy', 'Make it look like you': 'Que se parezca a ti', 'Start over': 'Empezar de nuevo',
    'Yes': 'Sí', 'No': 'No',
    'You are wearing an outfit from the Outfits shop. Take it off there to see these clothes.': 'Tienes puesto un disfraz de la tienda Disfraces. Quítatelo ahí para ver esta ropa.',
    // Shop panel
    'Tap to try it on. Buy it with your stars to keep it.': 'Toca algo para probártelo. Cómpralo con tus estrellas para quedártelo.',
    'Your picture on the home screen': 'Tu foto en la pantalla de inicio', 'Fun glasses': 'Lentes divertidos', 'Around your neck': 'En tu cuello',
    'On your back': 'En tu espalda', 'In your hand': 'En tu mano', 'Backgrounds': 'Fondos', 'Frames': 'Marcos', 'App colors': 'Colores de la app',
    'Wearing': 'Puesto', 'Yours': 'Tuyo', '⭐ {price}': '⭐ {price}', '⭐ {price} (need {n} more)': '⭐ {price} (faltan {n})', 'Buy for ⭐ {price}': 'Comprar por ⭐ {price}',
    'You need {n} more stars for the {name}. Play your games to earn more!': 'Te faltan {n} estrellas para {name}. ¡Juega para ganar más!',
    'Buy the {name} for {price} stars?': '¿Comprar {name} por {price} estrellas?', 'OK': 'Listo', 'Yes!': '¡Sí!', 'Not now': 'Ahora no',
    'You got the {name}!': '¡Ya tienes {name}!',
    // Looks: face, eyes, brows, nose, mouth
    'face|Round': 'Redonda', 'Oval': 'Ovalada', 'Heart': 'Corazón', 'face|Square': 'Cuadrada',
    'Round': 'Redondos', 'Square': 'Cuadrados', 'Almond': 'Almendrados', 'Wide': 'Grandes', 'Sleepy': 'Dormilones',
    'Natural': 'Naturales', 'Thin': 'Finas', 'Thick': 'Gruesas', 'Arched': 'Arqueadas', 'Soft': 'Suaves',
    'Button': 'Respingada', 'Small': 'Pequeña', 'nose|Wide': 'Ancha', 'nose|Long': 'Larga',
    'Smile': 'Sonrisa', 'Big grin': 'Sonrisa grande', 'Small smile': 'Sonrisa pequeña', 'Happy': 'Alegre',
    // Looks: hair
    'Short': 'Corto', 'Bob': 'Bob', 'Long': 'Largo', 'Ponytail': 'Cola de caballo', 'Pigtails': 'Coletas', 'Braids': 'Trenzas', 'Bun': 'Moño',
    'Curly': 'Rizado', 'Puff': 'Afro', 'Pixie': 'Pixie', 'Long and straight': 'Largo y liso', 'Bob with bangs': 'Bob con flequillo',
    'Curled bob': 'Bob con rizos', 'Sleek bob': 'Bob liso', 'Straight with bangs': 'Liso con flequillo', 'Braided bun': 'Moño trenzado',
    'Braid': 'Trenza', 'Two braids': 'Dos trenzas', 'Waves with headband': 'Ondas con diadema', 'Curls': 'Rizos', 'Short and wavy': 'Corto y ondulado',
    'Short side part': 'Corto con raya al lado', 'Afro': 'Afro',
    // Looks: clothes
    'T-shirt': 'Camiseta', 'Long sleeves': 'Manga larga', 'Hoodie': 'Sudadera', 'Stripes': 'Rayas', 'Tank top': 'Camiseta sin mangas', 'Dress': 'Vestido',
    'Tucked tee': 'Camiseta fajada', 'Polo shirt': 'Camiseta polo', 'Sweater': 'Suéter',
    'Jeans': 'Jeans', 'Leggings': 'Mallas', 'Shorts': 'Shorts', 'Skirt': 'Falda', 'Jean shorts': 'Shorts de jean', 'Cargo pants': 'Pantalón cargo',
    'Pants': 'Pantalón', 'Flowy pants': 'Pantalón suelto', 'Ruffle skirt': 'Falda con volantes', 'Tiered skirt': 'Falda de capas', 'Plaid skirt': 'Falda de cuadros',
    'Long skirt': 'Falda larga', 'Sundress': 'Vestido de verano', 'Flower dress': 'Vestido de flores', 'Party dress': 'Vestido de fiesta',
    'Tunic dress': 'Túnica', 'Overalls': 'Overol',
    'Sneakers': 'Tenis', 'Boots': 'Botas', 'Sandals': 'Sandalias', 'Flats': 'Zapatos bajos', 'Blue sneakers': 'Tenis azules', 'Leather shoes': 'Zapatos de cuero',
    'Mary Janes': 'Zapatos con correa', 'Flats with bows': 'Zapatos bajos con lazos', 'Flats with flowers': 'Zapatos bajos con flores',
    'Ankle boots': 'Botines', 'Rain boots': 'Botas de lluvia',
    'None': 'Ninguno', 'Short socks': 'Calcetines cortos', 'Knee socks': 'Calcetines a la rodilla', 'Frilly socks': 'Calcetines con volantes', 'Leg warmers': 'Calentadores',
    'Cat-eye': 'Ojo de gato', 'Black frames': 'Lentes negros', 'Round glasses': 'Lentes redondos', 'Library glasses': 'Lentes de lectura',
    'Leopard glasses': 'Lentes de leopardo', '3D glasses': 'Lentes 3D', 'Goggles': 'Lentes protectores',
    'Pearl earrings': 'Aretes de perla', 'Hoop earrings': 'Aretes de aro', 'Lightning earrings': 'Aretes de rayo',
    // Looks: body and pose
    'Shorter': 'Baja', 'Medium': 'Media', 'Taller': 'Alta', 'Slim': 'Delgada', 'Sturdy': 'Fuerte', 'Girl': 'Niña', 'Boy': 'Niño',
    'Stand': 'De pie', 'Wave': 'Saludando', 'Salute': 'Saludo', 'Hands on hips': 'Manos en la cintura', 'Cheer': 'Festejando', 'Shy': 'Tímida',
    'Hero': 'Heroica', 'Peace': 'Señal de paz', 'Strike a pose': 'Posando', 'Fly': 'Volando',
    // Face sliders
    'Face width': 'Ancho de cara', 'Cheeks': 'Mejillas', 'Jaw': 'Mandíbula', 'Chin': 'Mentón', 'Eye size': 'Tamaño de ojos', 'Eyes apart': 'Ojos separados',
    'Eyebrow height': 'Altura de cejas', 'Nose size': 'Tamaño de nariz', 'Nose width': 'Ancho de nariz', 'Nose tip': 'Punta de nariz', 'Lips': 'Labios',
    'Mouth width': 'Ancho de boca', 'Ears': 'Orejas',
    // Shop: hats
    'Big bow': 'Lazo grande', 'Party hat': 'Gorro de fiesta', 'Flower clip': 'Broche de flor', 'Ball cap': 'Gorra', 'Beanie': 'Gorro tejido',
    'Bucket hat': 'Sombrero de pescador', 'Beret': 'Boina', 'Sun hat': 'Sombrero de sol', 'Bear ears': 'Orejas de oso', 'Mouse ears': 'Orejas de ratón',
    'Fox ears': 'Orejas de zorro', 'Cat ears': 'Orejas de gato', 'Bunny ears': 'Orejas de conejo', 'Pirate hat': 'Sombrero pirata', 'Frog hat': 'Gorro de rana',
    'Cowboy hat': 'Sombrero vaquero', 'Reindeer antlers': 'Cuernos de reno', 'Propeller cap': 'Gorra con hélice', 'Top hat': 'Sombrero de copa',
    'Graduation cap': 'Birrete', 'Flower crown': 'Corona de flores', 'Viking helmet': 'Casco vikingo', 'Jester hat': 'Gorro de bufón', 'Headphones': 'Audífonos',
    'Wizard hat': 'Sombrero de mago', 'Halo': 'Halo', 'Unicorn horn': 'Cuerno de unicornio', 'Knight helmet': 'Casco de caballero', 'Tiara': 'Tiara',
    'Star crown': 'Corona de estrellas', 'Crown': 'Corona', 'Newsboy cap': 'Gorra plana', 'Santa hat': 'Gorro de Santa',
    // Shop: fun glasses
    'Sun visor': 'Visera', 'Sunglasses': 'Lentes de sol', 'Swim goggles': 'Lentes de natación', 'Pink shades': 'Lentes rosas', 'Hero mask': 'Antifaz de héroe',
    'Heart glasses': 'Lentes de corazón', 'Star glasses': 'Lentes de estrella', 'Aviators': 'Lentes de aviador', 'Butterfly glasses': 'Lentes de mariposa',
    'Rainbow glasses': 'Lentes arcoíris', 'Monocle': 'Monóculo',
    // Shop: around her neck
    'Bow tie': 'Corbatín', 'Bandana': 'Pañuelo', 'Cozy scarf': 'Bufanda', 'Tie': 'Corbata', 'Friendship beads': 'Collar de la amistad', 'Flower lei': 'Collar de flores',
    'Rainbow scarf': 'Bufanda arcoíris', 'Pearl necklace': 'Collar de perlas', 'Heart locket': 'Medallón de corazón', 'Gold medal': 'Medalla de oro',
    'Star necklace': 'Collar de estrella', 'Crystal pendant': 'Colgante de cristal',
    // Shop: on her back
    'Backpack': 'Mochila', 'Turtle shell': 'Caparazón de tortuga', 'Bee wings': 'Alas de abeja', 'Ladybug wings': 'Alas de mariquita', 'Hero cape': 'Capa de héroe',
    'Balloon bunch': 'Globos', 'Guitar': 'Guitarra', 'Bat wings': 'Alas de murciélago', 'Fairy wings': 'Alas de hada', 'Butterfly wings': 'Alas de mariposa',
    'Jet pack': 'Mochila cohete', 'Dragon wings': 'Alas de dragón', 'Angel wings': 'Alas de ángel', 'Unicorn wings': 'Alas de unicornio', 'Rainbow wings': 'Alas arcoíris',
    'Phoenix wings': 'Alas de fénix',
    // Shop: in her hand
    'Lollipop': 'Paleta de dulce', 'Ice cream': 'Helado', 'Balloon': 'Globo', 'Book': 'Libro', 'Sunflower': 'Girasol', 'Paintbrush': 'Pincel',
    'Magnifying glass': 'Lupa', 'Bubble wand': 'Varita de burbujas', 'Umbrella': 'Paraguas', 'Microphone': 'Micrófono', 'Magic wand': 'Varita mágica',
    'Foam sword': 'Espada de espuma', 'Teddy bear': 'Osito de peluche', 'Lantern': 'Farol', 'Trophy': 'Trofeo',
    // Shop: outfits
    'Pajamas': 'Pijama', 'Soccer kit': 'Uniforme de fútbol', 'Chef': 'Chef', 'Doctor': 'Doctor', 'Ballerina': 'Bailarina', 'Cowpoke': 'Vaquero',
    'Scientist': 'Científico', 'Pirate': 'Pirata', 'Ninja': 'Ninja', 'Firefighter': 'Bombero', 'Superhero': 'Superhéroe', 'Wizard': 'Mago',
    'Rock star': 'Estrella de rock', 'Fairy': 'Hada', 'Princess gown': 'Vestido de princesa', 'Knight': 'Caballero', 'Astronaut': 'Astronauta',
    'Sea princess': 'Princesa del mar',
    // Shop: pets
    'Goldfish': 'Pez dorado', 'Frog': 'Rana', 'Hamster': 'Hámster', 'Turtle': 'Tortuga', 'Kitten': 'Gatito', 'Puppy': 'Perrito', 'Bunny': 'Conejito',
    'Parrot': 'Loro', 'Spotty puppy': 'Perrito con manchas', 'Penguin': 'Pingüino', 'Fox': 'Zorro', 'Owl': 'Búho', 'Panda': 'Panda', 'Lion cub': 'Leoncito',
    'Baby dragon': 'Dragón bebé', 'Baby unicorn': 'Unicornio bebé',
    // Shop: places
    'My room': 'Mi cuarto', 'Park': 'Parque', 'Beach': 'Playa', 'Desert': 'Desierto', 'Art studio': 'Taller de arte', 'Farm': 'Granja', 'Snowy day': 'Día de nieve',
    'City': 'Ciudad', 'Jungle': 'Selva', 'Night sky': 'Cielo de noche', 'Castle': 'Castillo', 'Space': 'Espacio', 'Under the sea': 'Bajo el mar',
    'Sunset': 'Atardecer', 'Rainbow hill': 'Colina arcoíris', 'Volcano island': 'Isla del volcán', 'Big stage': 'Gran escenario', 'Candy land': 'País de los dulces',
    'Cloud kingdom': 'Reino de nubes', 'Ice palace': 'Palacio de hielo',
    // Shop: sparkles
    'Glitter': 'Brillantina', 'Hearts': 'Corazones', 'Bubbles': 'Burbujas', 'Falling leaves': 'Hojas que caen', 'Star ring': 'Anillo de estrellas',
    'Snowflakes': 'Copos de nieve', 'Music notes': 'Notas musicales', 'Flower petals': 'Pétalos', 'Confetti': 'Confeti', 'Fireflies': 'Luciérnagas',
    'Butterflies': 'Mariposas', 'Rainbow rings': 'Anillos arcoíris',
    // Shop: her home screen picture
    'Blue sky': 'Cielo azul', 'Mint': 'Menta', 'Polka dots': 'Lunares', 'Ocean': 'Océano', 'Candy stripes': 'Rayas de dulce', 'Rainbow': 'Arcoíris', 'Galaxy': 'Galaxia',
    'Sunshine frame': 'Marco de sol', 'Gold frame': 'Marco dorado', 'Star frame': 'Marco de estrellas', 'Heart frame': 'Marco de corazones',
    'Flower frame': 'Marco de flores', 'Rainbow frame': 'Marco arcoíris', 'Galaxy frame': 'Marco galaxia', 'Crystal frame': 'Marco de cristal',
    // Shop: colours for this app
    'Forest': 'Bosque', 'Candy': 'Dulce', 'Midnight': 'Medianoche', 'Unicorn pastel': 'Unicornio pastel',
    // Shop: hair dyes
    'Pink hair': 'Cabello rosa', 'Purple hair': 'Cabello morado', 'Blue hair': 'Cabello azul', 'Teal hair': 'Cabello turquesa', 'Red hair': 'Cabello rojo',
    'Orange hair': 'Cabello naranja', 'Mint hair': 'Cabello menta', 'Lavender hair': 'Cabello lavanda', 'Coral hair': 'Cabello coral', 'Lime hair': 'Cabello lima',
    'Midnight blue hair': 'Cabello azul noche', 'Silver hair': 'Cabello plateado', 'Gold hair': 'Cabello dorado',
  };
  const USED = new Set();
  function T(s, vars, ctx) {
    const k = ctx && ES[ctx + '|' + s] != null ? ctx + '|' + s : s;
    USED.add(k);
    let t = LANG === 'es' && ES[k] != null ? ES[k] : s;
    if (vars) t = t.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
    return t;
  }
  window.AVATAR_LANG = { LANG, ES, T };
  window.DucklingLang = {
    keys: () => Object.keys(ES),
    missing: () => [...USED].filter((k) => ES[k] == null),
    allow: ['color'],   // Spanish too: Color de ojos
  };
})();
