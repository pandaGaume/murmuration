const fs = require("fs");
const path = require("path");
const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
    ShadingType, PageNumber, PageBreak, LevelFormat, ImageRun
} = require("docx");

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const PAGE_WIDTH = 11906; // A4
const PAGE_HEIGHT = 16838;
const MARGIN = 1440; // 1 inch
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN; // 9026 DXA

const COLOR = {
    primary: "1B4F72",
    secondary: "2E86C1",
    accent: "E8F0FE",
    text: "2C3E50",
    light: "F8F9FA",
    border: "BDC3C7",
};

const border = { style: BorderStyle.SINGLE, size: 1, color: COLOR.border };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function heading(text, level) {
    return new Paragraph({
        heading: level,
        spacing: { before: level === HeadingLevel.HEADING_1 ? 360 : 240, after: 200 },
        children: [new TextRun({ text, bold: true, font: "Calibri",
            size: level === HeadingLevel.HEADING_1 ? 32 : level === HeadingLevel.HEADING_2 ? 28 : 24,
            color: COLOR.primary })],
    });
}

function para(text, opts = {}) {
    return new Paragraph({
        spacing: { after: 120, line: 276 },
        alignment: opts.align || AlignmentType.JUSTIFIED,
        children: [new TextRun({ text, font: "Calibri", size: 22, color: COLOR.text, ...opts.run })],
    });
}

function italicPara(text) {
    return para(text, { run: { italics: true } });
}

function boldPara(text) {
    return para(text, { run: { bold: true } });
}

function ref(authors, year, title, source) {
    return new Paragraph({
        spacing: { after: 80 },
        indent: { left: 360, hanging: 360 },
        children: [
            new TextRun({ text: `${authors} (${year}). `, font: "Calibri", size: 20, color: COLOR.text }),
            new TextRun({ text: title, font: "Calibri", size: 20, color: COLOR.text, italics: true }),
            new TextRun({ text: `. ${source}`, font: "Calibri", size: 20, color: COLOR.text }),
        ],
    });
}

function headerCell(text, width) {
    return new TableCell({
        borders, width: { size: width, type: WidthType.DXA },
        shading: { fill: COLOR.primary, type: ShadingType.CLEAR },
        margins: cellMargins,
        children: [new Paragraph({ children: [new TextRun({ text, font: "Calibri", size: 20, bold: true, color: "FFFFFF" })] })],
    });
}

function cell(text, width) {
    return new TableCell({
        borders, width: { size: width, type: WidthType.DXA },
        margins: cellMargins,
        children: [new Paragraph({ children: [new TextRun({ text, font: "Calibri", size: 20, color: COLOR.text })] })],
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Document structure
// ═══════════════════════════════════════════════════════════════════════════

const doc = new Document({
    styles: {
        default: { document: { run: { font: "Calibri", size: 22 } } },
        paragraphStyles: [
            { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
                run: { size: 32, bold: true, font: "Calibri", color: COLOR.primary },
                paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
            { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
                run: { size: 28, bold: true, font: "Calibri", color: COLOR.primary },
                paragraph: { spacing: { before: 240, after: 180 }, outlineLevel: 1 } },
            { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
                run: { size: 24, bold: true, font: "Calibri", color: COLOR.secondary },
                paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 } },
        ],
    },
    numbering: {
        config: [{
            reference: "bullets",
            levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
                style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
        }],
    },
    sections: [{
        properties: {
            page: {
                size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
                margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
            },
        },
        headers: {
            default: new Header({
                children: [new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    children: [new TextRun({ text: "MURMURATION \u2014 Fiche Scientifique CIR 2026", font: "Calibri", size: 18, color: COLOR.secondary, italics: true })],
                })],
            }),
        },
        footers: {
            default: new Footer({
                children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({ text: "Page ", font: "Calibri", size: 18, color: "999999" }),
                        new TextRun({ children: [PageNumber.CURRENT], font: "Calibri", size: 18, color: "999999" })],
                })],
            }),
        },
        children: [
            // ═══════════════════════════════════════════════════════════════
            // PAGE DE GARDE
            // ═══════════════════════════════════════════════════════════════
            new Paragraph({ spacing: { before: 2400 } }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "DOSSIER JUSTIFICATIF", font: "Calibri", size: 28, bold: true, color: COLOR.secondary })],
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 120 },
                children: [new TextRun({ text: "CREDIT IMPOT RECHERCHE", font: "Calibri", size: 36, bold: true, color: COLOR.primary })],
            }),
            new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.CENTER, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.secondary, space: 1 } }, children: [] }),
            new Paragraph({ spacing: { before: 400 } }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 120 },
                children: [new TextRun({ text: "PARTIE 2 \u2014 FICHE SCIENTIFIQUE", font: "Calibri", size: 26, bold: true, color: COLOR.primary })],
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 400 },
                children: [new TextRun({ text: "Architecture de navigation autonome par cascade de r\u00e9seaux de neurones\npour rover plan\u00e9taire avec jumeau num\u00e9rique", font: "Calibri", size: 24, italics: true, color: COLOR.text })],
            }),
            new Paragraph({ spacing: { before: 600 } }),
            new Table({
                width: { size: 5000, type: WidthType.DXA },
                columnWidths: [2000, 3000],
                rows: [
                    new TableRow({ children: [
                        cell("Entreprise", 2000), cell("[\u00c0 COMPL\u00c9TER]", 3000)] }),
                    new TableRow({ children: [
                        cell("SIREN", 2000), cell("[\u00c0 COMPL\u00c9TER]", 3000)] }),
                    new TableRow({ children: [
                        cell("Op\u00e9ration R&D", 2000), cell("MURMURATION \u2014 Navigation autonome par MLP cascade", 3000)] }),
                    new TableRow({ children: [
                        cell("Ann\u00e9e", 2000), cell("2026", 3000)] }),
                ],
            }),

            new Paragraph({ children: [new PageBreak()] }),

            // ═══════════════════════════════════════════════════════════════
            // 2.1 DESCRIPTION SCIENTIFIQUE DES TRAVAUX
            // ═══════════════════════════════════════════════════════════════
            heading("2.1 Description scientifique des travaux", HeadingLevel.HEADING_1),

            // --- 2.1.1 ETAT DE L'ART ---
            heading("2.1.1 Analyse critique de l'\u00e9tat de l'art", HeadingLevel.HEADING_2),

            heading("a) Contexte scientifique et technologique", HeadingLevel.HEADING_3),

            para("Le projet Murmuration vise le d\u00e9veloppement d'une architecture de navigation autonome pour rovers plan\u00e9taires, combinant des jumeaux num\u00e9riques haute-fid\u00e9lit\u00e9, des contr\u00f4leurs neuronaux l\u00e9gers de type Perceptron Multi-Couches (MLP), et une supervision par mod\u00e8le de langage (LLM) via le protocole Model Context Protocol (MCP). Les travaux s'inscrivent \u00e0 l'intersection de trois domaines scientifiques : la robotique autonome, l'apprentissage par renforcement distribu\u00e9, et les architectures neuronales embarqu\u00e9es pour syst\u00e8mes \u00e0 ressources contraintes."),

            para("La navigation plan\u00e9taire autonome constitue un d\u00e9fi scientifique majeur en raison des latences de communication Terre-Mars (4 \u00e0 24 minutes aller simple), de l'impossibilit\u00e9 de t\u00e9l\u00e9op\u00e9ration en temps r\u00e9el, et de la n\u00e9cessit\u00e9 de d\u00e9cisions embarqu\u00e9es fiables sur mat\u00e9riel \u00e0 faible consommation \u00e9nerg\u00e9tique. Les rovers actuels (Curiosity, Perseverance) reposent sur des pipelines de contr\u00f4le manuellement con\u00e7us, limitant la distance de travers\u00e9e quotidienne et le tempo op\u00e9rationnel [Jakobi et al., 1995]."),

            heading("b) Revue critique des travaux existants", HeadingLevel.HEADING_3),

            boldPara("Transfert simulation vers r\u00e9alit\u00e9 (sim-to-real)"),
            para("Jakobi, Husbands et Harvey (1995) ont identifi\u00e9 les premiers le bruit sensoriel et la fid\u00e9lit\u00e9 environnementale comme facteurs critiques du transfert de contr\u00f4leurs \u00e9volu\u00e9s vers des robots physiques. La randomisation de domaine, qui consiste \u00e0 varier les param\u00e8tres de simulation durant l'entra\u00eenement, s'est impos\u00e9e comme technique de r\u00e9f\u00e9rence. Le projet Space Robotics Bench (2025) d\u00e9montre que la diversit\u00e9 des sc\u00e9narios proc\u00e9duraux surpasse la fid\u00e9lit\u00e9 d'un jumeau unique pour le transfert zero-shot de politiques de navigation de rover. N\u00e9anmoins, aucun cadre publi\u00e9 ne combine randomisation de domaine avec un jumeau num\u00e9rique dont la fid\u00e9lit\u00e9 sensorielle est garantie par construction mat\u00e9rielle."),

            boldPara("Architectures neuronales pour la navigation robotique"),
            para("Les approches contemporaines privil\u00e9gient les architectures profondes (CNN, Transformer, LSTM) coupl\u00e9es \u00e0 l'apprentissage par renforcement profond [Sun et al., 2024]. Cependant, ces mod\u00e8les requi\u00e8rent des ressources computationnelles incompatibles avec le d\u00e9ploiement embarqu\u00e9 sur microcontr\u00f4leur. Les travaux de Ha et Schmidhuber (2018) sur les World Models montrent qu'un agent dot\u00e9 d'un mod\u00e8le interne de l'environnement peut d\u00e9velopper des politiques efficaces, mais leur impl\u00e9mentation repose sur des r\u00e9seaux r\u00e9currents co\u00fbteux en calcul."),

            para("La litt\u00e9rature r\u00e9cente identifie une tension fondamentale entre capacit\u00e9 du mod\u00e8le et contraintes embarqu\u00e9es. Les surveys de 2024-2025 sur la navigation de robots mobiles par apprentissage profond [Springer JIRS, 2024 ; Frontiers Neurorobotics, 2025] confirment la dominance des m\u00e9thodes DRL (PPO, SAC) mais rel\u00e8vent que les politiques MLP l\u00e9g\u00e8res, comme CANet qui utilise un MLP pour produire des distributions de probabilit\u00e9 sur des clusters de vitesse, restent sous-explor\u00e9es malgr\u00e9 leur ad\u00e9quation aux syst\u00e8mes embarqu\u00e9s."),

            boldPara("Fusion capteurs et odom\u00e9trie multi-roues"),
            para("La fusion de donn\u00e9es LiDAR, IMU et encodeurs de roues constitue le socle de la localisation robotique. Li et al. (2024) proposent une odom\u00e9trie \u00e9troitement coupl\u00e9e LiDAR-IMU-roues avec calibration en ligne du mod\u00e8le cin\u00e9matique pour robots \u00e0 direction par d\u00e9rapage. L'odom\u00e9trie diff\u00e9rentielle classique repose sur l'int\u00e9gration des ticks d'encodeurs via les \u00e9quations cin\u00e9matiques standard, mais la litt\u00e9rature ne propose pas de solution g\u00e9n\u00e9ralis\u00e9e pour l'agr\u00e9gation de N roues par c\u00f4t\u00e9 avec filtrage de glissement individuel."),

            para("Les travaux sur la d\u00e9tection de glissement [PMC, 2025] utilisent des approches data-driven (GPR, LSTM) pour compenser le patinage, mais n\u00e9cessitent un entra\u00eenement sp\u00e9cifique \u00e0 chaque configuration de rover. La m\u00e9thode Sensor Consensus Analysis (SCA) propose une approche statistique (z-test) pour d\u00e9tecter les incoh\u00e9rences inter-capteurs, mais reste limit\u00e9e \u00e0 des configurations \u00e0 deux roues."),

            boldPara("LLM comme m\u00e9ta-superviseur de l'apprentissage"),
            para("L'utilisation de LLM pour la conception automatique de fonctions de r\u00e9compense en apprentissage par renforcement conna\u00eet un essor rapide. Le framework CARD [Sun et al., 2024] utilise un LLM g\u00e9n\u00e9rateur et un \u00e9valuateur pour it\u00e9rer sur le code de r\u00e9compense, avec \u00e9valuation par pr\u00e9f\u00e9rences de trajectoire. Le framework LEARN-Opt (2025) automatise l'extraction d'\u00e9tats et d'actions puis la g\u00e9n\u00e9ration de fonctions de r\u00e9compense candidates. Cependant, ces travaux se concentrent sur l'optimisation de r\u00e9compense pour un agent unique ; l'utilisation d'un LLM comme m\u00e9ta-superviseur coordonnant l'entra\u00eenement distribu\u00e9 de multiples jumeaux num\u00e9riques reste un territoire inexplor\u00e9."),

            heading("c) Identification et justification des verrous scientifiques", HeadingLevel.HEADING_3),

            para("L'analyse de l'\u00e9tat de l'art r\u00e9v\u00e8le trois verrous scientifiques que le projet Murmuration vise \u00e0 lever :"),

            boldPara("Verrou 1 : S\u00e9paration perception-d\u00e9cision dans un contr\u00f4leur neuronal embarqu\u00e9 ultra-l\u00e9ger"),
            para("Les architectures monolithiques (un seul r\u00e9seau capteurs-vers-action) forcent le m\u00eame espace de poids \u00e0 apprendre simultan\u00e9ment la reconnaissance de patterns spatiaux (perception) et la politique de contr\u00f4le (d\u00e9cision). La litt\u00e9rature identifie ce probl\u00e8me [Frontiers Neurorobotics, 2025] mais propose des solutions end-to-end co\u00fbteuses (Transformers spatio-temporels). Aucune solution publi\u00e9e ne d\u00e9montre une architecture MLP en cascade (perception puis d\u00e9cision) avec moins de 1 500 param\u00e8tres entra\u00eenables, capable d'inf\u00e9rence sub-milliseconde sur microcontr\u00f4leur."),

            boldPara("Verrou 2 : Odom\u00e9trie diff\u00e9rentielle g\u00e9n\u00e9ralis\u00e9e \u00e0 N roues avec filtrage de glissement par c\u00f4t\u00e9"),
            para("Les algorithmes d'odom\u00e9trie diff\u00e9rentielle existants supposent exactement deux roues (une par c\u00f4t\u00e9). Les rovers \u00e0 6 roues (type rocker-bogie) n\u00e9cessitent une agr\u00e9gation par c\u00f4t\u00e9 avec exclusion des roues en glissement avant moyennage, un probl\u00e8me non trait\u00e9 dans la litt\u00e9rature sous forme d'algorithme g\u00e9n\u00e9ralis\u00e9 param\u00e9trique."),

            boldPara("Verrou 3 : M\u00e9ta-supervision LLM de l'entra\u00eenement distribu\u00e9 de jumeaux num\u00e9riques"),
            para("L'utilisation de LLM pour optimiser les fonctions de r\u00e9compense a \u00e9t\u00e9 d\u00e9montr\u00e9e pour un agent unique [CARD, LEARN-Opt]. L'extension \u00e0 la coordination de multiples jumeaux num\u00e9riques parall\u00e8les, avec ajustement des strat\u00e9gies d'exploration et diffusion s\u00e9lective des poids entre instances, repr\u00e9sente un d\u00e9fi scientifique non adress\u00e9."),

            new Paragraph({ children: [new PageBreak()] }),

            // --- 2.1.2 RESULTATS ---
            heading("2.1.2 R\u00e9sultats obtenus et contributions", HeadingLevel.HEADING_2),

            heading("a) D\u00e9marche scientifique et hypoth\u00e8ses de travail", HeadingLevel.HEADING_3),

            para("Les travaux r\u00e9alis\u00e9s en mars 2026 portent sur la conception et l'impl\u00e9mentation des couches fondamentales de l'architecture Murmuration : les interfaces de capteurs, l'odom\u00e9trie diff\u00e9rentielle g\u00e9n\u00e9ralis\u00e9e, et l'architecture neuronale en cascade pour la navigation r\u00e9active. La d\u00e9marche suit une approche hypoth\u00e9tico-d\u00e9ductive :"),

            para("Hypoth\u00e8se H1 : Une architecture MLP en cascade (perception 42\u219216\u21928 puis d\u00e9cision 21\u219216\u21924) produit des commandes de navigation de qualit\u00e9 \u00e9quivalente ou sup\u00e9rieure \u00e0 un MLP monolithique (55\u219232\u21924) avec 35% de param\u00e8tres en moins (1 244 vs 1 924)."),

            para("Hypoth\u00e8se H2 : Le filtrage de glissement par c\u00f4t\u00e9 avec moyennage des roues non-glissantes am\u00e9liore la fiabilit\u00e9 de l'estimation odom\u00e9trique pour des rovers \u00e0 6 roues par rapport \u00e0 un moyennage na\u00eff de toutes les roues."),

            heading("b) R\u00e9sultats quantitatifs et qualitatifs", HeadingLevel.HEADING_3),

            boldPara("R\u00e9sultat 1 : Architecture MLP en cascade (MLP-Percept + MLP-Decide)"),

            para("Nous avons con\u00e7u et impl\u00e9ment\u00e9 une architecture neuronale en deux \u00e9tages ind\u00e9pendants, rempla\u00e7ant le MLP monolithique initial. Le premier \u00e9tage (MLP-Percept, 42\u219216\u21928, 824 param\u00e8tres) compresse les donn\u00e9es spatiales brutes (36 secteurs LiDAR + 6 valeurs IMU) en 8 features apprises. L'activation de sortie est tanh (plage [\u22121, +1]) pour pr\u00e9server l'information directionnelle. Le second \u00e9tage (MLP-Decide, 21\u219216\u21924, 420 param\u00e8tres) prend en entr\u00e9e les 8 features de perception, la pose fus\u00e9e (6), les ratios de glissement par roue (4) et le vecteur objectif (3), et produit les commandes moteur (direction, acc\u00e9l\u00e9ration, freinage, score de risque) via activation sigmoid."),

            // Parameter comparison table
            new Table({
                width: { size: CONTENT_WIDTH, type: WidthType.DXA },
                columnWidths: [3000, 2000, 2000, 2026],
                rows: [
                    new TableRow({ children: [
                        headerCell("Architecture", 3000), headerCell("Poids", 2000),
                        headerCell("Biais", 2000), headerCell("Total", 2026)] }),
                    new TableRow({ children: [
                        cell("Monolithique 55\u219232\u21924", 3000), cell("1 888", 2000),
                        cell("36", 2000), cell("1 924", 2026)] }),
                    new TableRow({ children: [
                        cell("Cascade [42\u219216\u21928] + [21\u219216\u21924]", 3000), cell("1 200", 2000),
                        cell("44", 2000), cell("1 244", 2026)] }),
                    new TableRow({ children: [
                        cell("R\u00e9duction", 3000), cell("", 2000),
                        cell("", 2000), cell("\u221235%", 2026)] }),
                ],
            }),
            new Paragraph({ spacing: { after: 200 } }),

            para("Cette s\u00e9paration permet l'entra\u00eenement ind\u00e9pendant de chaque \u00e9tage : la perception peut \u00eatre entra\u00een\u00e9e sur une t\u00e2che de d\u00e9tection d'obstacles, puis gel\u00e9e pendant que la d\u00e9cision \u00e9volue sur une t\u00e2che d'atteinte d'objectif. Les 8 features interm\u00e9diaires constituent une repr\u00e9sentation interpr\u00e9table et visualisable de la situation spatiale."),

            boldPara("R\u00e9sultat 2 : Odom\u00e9trie diff\u00e9rentielle g\u00e9n\u00e9ralis\u00e9e \u00e0 N roues"),

            para("L'algorithme DifferentialOdometry impl\u00e9mente une odom\u00e9trie diff\u00e9rentielle g\u00e9n\u00e9ralis\u00e9e acceptant un nombre arbitraire de roues par c\u00f4t\u00e9 (2, 4 ou 6 roues). Pour chaque c\u00f4t\u00e9, l'algorithme : (1) lit les encodeurs de toutes les roues, (2) exclut les roues dont le ratio de glissement d\u00e9passe un seuil configurable, (3) moyenne les d\u00e9placements des roues restantes. Si toutes les roues d'un c\u00f4t\u00e9 glissent, l'estimation utilise la moyenne brute mais est flag\u00e9e \"non fiable\" (quality = 64, norme OPC-UA). L'int\u00e9gration cin\u00e9matique utilise la m\u00e9thode midpoint arc (theta + dTheta/2) pour r\u00e9duire la d\u00e9rive sur trajectoires courbes."),

            boldPara("R\u00e9sultat 3 : Couche d'abstraction capteurs framework-agnostique"),

            para("Une hi\u00e9rarchie d'interfaces TypeScript d\u00e9finit un contrat uniforme pour les capteurs (ISensorNode, ISensorReadable, ISensorEventEmitter) ind\u00e9pendant du framework 3D sous-jacent. Les interfaces sp\u00e9cialis\u00e9es couvrent l'IMU 6-DOF (IAccelerometerNode, IGyroNode, IIMU6Node), le LiDAR (ILidarNode avec grilles de profondeur configurables), les encodeurs de roues (IWheelEncoderNode avec d\u00e9tection de glissement), et l'odom\u00e9trie (IDifferentialOdometryNode). Le package murmuration-babylon fournit les adaptateurs concrets pour BabylonJS, d\u00e9montrant la portabilit\u00e9 du design."),

            heading("c) Contribution \u00e0 l'acquisition de connaissances nouvelles", HeadingLevel.HEADING_3),

            para("Les travaux apportent trois contributions originales \u00e0 l'\u00e9tat de l'art :"),

            para("(1) La d\u00e9monstration qu'une architecture MLP en cascade avec s\u00e9paration explicite perception/d\u00e9cision peut fonctionner avec seulement 1 244 param\u00e8tres tout en produisant une repr\u00e9sentation interm\u00e9diaire interpr\u00e9table. Cette approche est inexplorée dans la litt\u00e9rature pour les contr\u00f4leurs embarqu\u00e9s ultra-l\u00e9gers."),

            para("(2) Un algorithme d'odom\u00e9trie diff\u00e9rentielle g\u00e9n\u00e9ralis\u00e9 \u00e0 N roues par c\u00f4t\u00e9 avec filtrage de glissement individuel, applicable du robot diff\u00e9rentiel \u00e0 2 roues au rover \u00e0 6 roues sans modification de l'algorithme. La litt\u00e9rature existante traite le cas 2 roues ou utilise des mod\u00e8les cin\u00e9matiques sp\u00e9cifiques \u00e0 chaque configuration."),

            para("(3) Une architecture d'interfaces de capteurs ind\u00e9pendante du framework 3D, permettant la r\u00e9utilisation des mod\u00e8les de navigation entre moteurs de simulation (BabylonJS, Three.js, Unity) sans modification du code de perception ou de navigation."),

            heading("d) Transf\u00e9rabilit\u00e9 des r\u00e9sultats", HeadingLevel.HEADING_3),

            para("Les r\u00e9sultats sont transf\u00e9rables au-del\u00e0 du contexte plan\u00e9taire : l'architecture MLP en cascade et l'odom\u00e9trie N-roues sont applicables \u00e0 tout robot mobile autonome \u00e0 direction diff\u00e9rentielle (logistique d'entrep\u00f4t, agriculture de pr\u00e9cision, inspection industrielle). La couche d'abstraction capteurs constitue un cadre r\u00e9utilisable pour tout projet de jumeau num\u00e9rique robotique n\u00e9cessitant l'ind\u00e9pendance vis-\u00e0-vis du moteur de rendu."),

            new Paragraph({ children: [new PageBreak()] }),

            // ═══════════════════════════════════════════════════════════════
            // 2.2 PERSONNEL R&D
            // ═══════════════════════════════════════════════════════════════
            heading("2.2 Contribution directe du personnel R&D", HeadingLevel.HEADING_1),

            italicPara("[\u00c0 COMPL\u00c9TER \u2014 Tableau nominatif du personnel ayant contribu\u00e9 aux travaux de R&D]"),

            new Table({
                width: { size: CONTENT_WIDTH, type: WidthType.DXA },
                columnWidths: [2000, 1500, 1500, 2526, 1500],
                rows: [
                    new TableRow({ children: [
                        headerCell("Nom", 2000), headerCell("Dipl\u00f4me", 1500),
                        headerCell("Fonction", 1500), headerCell("Contribution", 2526),
                        headerCell("Temps (j)", 1500)] }),
                    new TableRow({ children: [
                        cell("Guillaume Pelletier", 2000), cell("[\u00c0 COMPL\u00c9TER]", 1500),
                        cell("Chercheur principal", 1500), cell("Architecture MLP cascade, odom\u00e9trie N-roues, interfaces capteurs, adaptateurs BabylonJS", 2526),
                        cell("[\u00c0 COMPL\u00c9TER]", 1500)] }),
                    new TableRow({ children: [
                        cell("[\u00c0 COMPL\u00c9TER]", 2000), cell("[\u00c0 COMPL\u00c9TER]", 1500),
                        cell("[\u00c0 COMPL\u00c9TER]", 1500), cell("[\u00c0 COMPL\u00c9TER]", 2526),
                        cell("[\u00c0 COMPL\u00c9TER]", 1500)] }),
                ],
            }),

            new Paragraph({ children: [new PageBreak()] }),

            // ═══════════════════════════════════════════════════════════════
            // 2.3 TRAVAUX EXTERNALISES
            // ═══════════════════════════════════════════════════════════════
            heading("2.3 Travaux externalis\u00e9s", HeadingLevel.HEADING_1),

            italicPara("[\u00c0 COMPL\u00c9TER si applicable \u2014 Sous-traitance agr\u00e9\u00e9e, partenariats scientifiques]"),

            para("Collaboration acad\u00e9mique envisag\u00e9e avec University of Houston, Dept. of Aerospace Engineering (co-PI \u00e0 confirmer)."),

            new Paragraph({ children: [new PageBreak()] }),

            // ═══════════════════════════════════════════════════════════════
            // BIBLIOGRAPHIE
            // ═══════════════════════════════════════════════════════════════
            heading("Bibliographie", HeadingLevel.HEADING_1),

            ref("Ha, D., & Schmidhuber, J.", "2018",
                "World Models",
                "arXiv preprint arXiv:1803.10122"),

            ref("Jakobi, N., Husbands, P., & Harvey, I.", "1995",
                "Noise and the Reality Gap: The Use of Simulation in Evolutionary Robotics",
                "Proceedings of the Third European Conference on Advances in Artificial Life, LNCS Vol. 929, pp. 702\u2013720. Springer"),

            ref("Kegeleirs, M., & Birattari, M.", "2025",
                "Towards Applied Swarm Robotics: Current Limitations and Enablers",
                "Frontiers in Robotics and AI, 12, 1607978"),

            ref("Li, X. et al.", "2024",
                "Tightly-Coupled LiDAR-IMU-Wheel Odometry with Online Calibration of a Kinematic Model for Skid-Steering Robots",
                "arXiv:2404.02515"),

            ref("Rosen, R., von Wichert, G., Lo, G., & Bettenhausen, K. D.", "2015",
                "About The Importance of Autonomy and Digital Twins for the Future of Manufacturing",
                "IFAC-PapersOnLine, 48, pp. 567\u2013572"),

            ref("Sun, S., Liu, R., Lyu, J., Yang, J.-W., Zhang, L., & Li, X.", "2024",
                "A Large Language Model-Driven Reward Design Framework via Dynamic Feedback for Reinforcement Learning (CARD)",
                "arXiv:2410.14660"),

            ref("Tao, F., Zhang, H., Liu, A., & Nee, A. Y. C.", "2019",
                "Digital Twin in Industry: State-of-the-Art",
                "IEEE Transactions on Industrial Informatics, 15(4), pp. 2405\u20132415"),

            ref("Space Robotics Bench", "2025",
                "Robot Learning Beyond Earth",
                "arXiv:2509.23328"),

            ref("Wang, Y. et al.", "2025",
                "Visual-Inertial-Wheel Odometry with Slip Compensation and Dynamic Feature Elimination",
                "MDPI Sensors, 25(5), 1537"),

            ref("Zhang, A.", "2024",
                "A Simple Framework for Intrinsic Reward-Shaping for RL using LLM Feedback",
                "Stanford University Technical Report"),
        ],
    }],
});

// ═══════════════════════════════════════════════════════════════════════════
// Generate
// ═══════════════════════════════════════════════════════════════════════════

const outputPath = path.resolve(__dirname, "fiche-cir-murmuration-2026.docx");

Packer.toBuffer(doc).then(buffer => {
    fs.writeFileSync(outputPath, buffer);
    console.log("Generated:", outputPath);
    console.log("Size:", (buffer.length / 1024).toFixed(1), "KB");
});
