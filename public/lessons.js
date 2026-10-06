// Interactive lessons. Every move here is checked by scripts/check-lessons.js (legality + engine).
// Lesson format:
//   side: which colour the learner plays ('w' | 'b')
//   parts: positions to work through; each has
//     fen (default: starting position), pre (moves played before the learner starts),
//     intro (shown first), steps: [{ say, move: [accepted moves] | accept: 'mate', reply, why }]
//   Moves are written like e2e4 (from-square, to-square, optional promotion letter).
(function (root) {
  const COURSES = {
    openings: {
      title: 'Openings',
      blurb: 'Start every game with a plan: fight for the centre, develop fast, castle early.',
      lessons: [
        {
          id: 'op-principles', title: 'Opening principles', side: 'w',
          summary: 'The three habits behind every good opening.',
          parts: [{
            intro: 'Good openings follow simple rules: control the centre, develop your knights and bishops, and get your king safe. Let\'s play them.',
            steps: [
              { say: 'Grab the centre: push your king\'s pawn two squares.', move: ['e2e4'], reply: 'e7e5',
                why: 'The pawn on e4 controls d5 and f5, and opens lines for your queen and bishop.' },
              { say: 'Develop a knight toward the centre, attacking Black\'s pawn.', move: ['g1f3'], reply: 'b8c6',
                why: 'Knights are strongest near the centre. Nf3 attacks e5, so Black defends it with ...Nc6.' },
              { say: 'Bring out your light-squared bishop to an active diagonal aimed at f7.', move: ['f1c4'], reply: 'f8c5',
                why: 'f7 is only defended by Black\'s king, so it is a natural target early in the game.' },
              { say: 'Now get your king to safety. Castle kingside.', move: ['e1g1'], reply: 'g8f6',
                why: 'Castling tucks the king away and brings the rook toward the centre in a single move.' },
              { say: 'Finish your setup with a quiet pawn move that supports the centre and frees your other bishop.', move: ['d2d3', 'c2c3'], reply: 'd7d6',
                why: 'Centre, development, king safety: both sides followed the principles, and the middlegame can begin.' },
            ],
          }],
          outro: 'Remember the checklist: centre pawns, knights before bishops, castle early, don\'t move the same piece twice without a reason.',
        },
        {
          id: 'op-italian', title: 'The Italian Game', side: 'w',
          summary: 'A classical opening aiming straight at f7, then building a big centre.',
          parts: [{
            intro: 'The Italian Game develops quickly and prepares d4 to build a strong pawn centre.',
            steps: [
              { say: 'Start with the king\'s pawn.', move: ['e2e4'], reply: 'e7e5' },
              { say: 'Attack e5 with your knight.', move: ['g1f3'], reply: 'b8c6' },
              { say: 'The Italian bishop: put it on c4, eyeing f7.', move: ['f1c4'], reply: 'f8c5',
                why: 'Black mirrors you. This is the Giuoco Piano, "the quiet game".' },
              { say: 'Prepare d4 with a pawn move that will support it.', move: ['c2c3'], reply: 'g8f6',
                why: 'With c3 played, d4 will be backed up by a pawn. Black develops and hits your e4 pawn.' },
              { say: 'Strike in the centre now.', move: ['d2d4'], reply: 'e5d4',
                why: 'Black takes. You want to take back with a pawn and keep two pawns in the centre.' },
              { say: 'Recapture with the pawn to build your centre.', move: ['c3d4'], reply: 'c5b4',
                why: 'You now have pawns on e4 and d4. Black checks with the bishop.' },
              { say: 'Block the check with your dark-squared bishop.', move: ['c1d2'], reply: 'b4d2',
                why: 'Blocking with the bishop develops a piece. Black trades.' },
              { say: 'Recapture with your queenside knight, developing it.', move: ['b1d2'], reply: 'd7d5',
                why: 'Black hits back in the centre with ...d5, the standard way to challenge White\'s big centre.' },
            ],
          }],
          outro: 'Key ideas: Bc4 + c3 + d4. If Black lets you keep pawns on e4 and d4, you get space and easy development.',
        },
        {
          id: 'op-ruy', title: 'The Ruy Lopez', side: 'w',
          summary: 'The most respected e4 e5 opening: pressure on the knight that defends e5.',
          parts: [{
            intro: 'The Ruy Lopez (Spanish) puts quiet, long-term pressure on Black\'s centre.',
            steps: [
              { say: 'King\'s pawn first.', move: ['e2e4'], reply: 'e7e5' },
              { say: 'Knight to f3, attacking e5.', move: ['g1f3'], reply: 'b8c6' },
              { say: 'The Spanish bishop: attack the knight that defends e5.', move: ['f1b5'], reply: 'a7a6',
                why: 'Black asks the bishop what it wants: the Morphy Defence.' },
              { say: 'Keep the bishop and the pin: retreat along the same diagonal.', move: ['b5a4'], reply: 'g8f6' },
              { say: 'Castle. e4 is safe for now because a trade on e4 lets you win the pawn back.', move: ['e1g1'], reply: 'f8e7' },
              { say: 'Defend e4 and put your rook on the half-open centre file.', move: ['f1e1'], reply: 'b7b5',
                why: 'Black gains space on the queenside and chases your bishop again.' },
              { say: 'Retreat the bishop to its best diagonal.', move: ['a4b3'], reply: 'd7d6' },
              { say: 'Prepare d4 and give your bishop a retreat square.', move: ['c2c3'], reply: 'e8g8' },
              { say: 'One last useful prophylactic move: stop ...Bg4 before it happens.', move: ['h2h3'],
                why: 'This is the main line of the Closed Ruy Lopez, played in world-championship matches for over a century.' },
            ],
          }],
          outro: 'Ruy Lopez ideas: Bb5 pressure, castle, Re1, c3 and d4. Slow, strong, and full of plans.',
        },
        {
          id: 'op-qgd', title: 'The Queen\'s Gambit', side: 'w',
          summary: 'Offer a pawn to win the centre: the classic 1.d4 opening.',
          parts: [{
            intro: 'The Queen\'s Gambit is not a real gambit: if Black takes on c4, White usually wins the pawn back.',
            steps: [
              { say: 'Start with the queen\'s pawn.', move: ['d2d4'], reply: 'd7d5' },
              { say: 'Offer the c-pawn to deflect Black\'s d5 pawn from the centre.', move: ['c2c4'], reply: 'e7e6',
                why: 'Black declines the gambit and supports d5: the Queen\'s Gambit Declined.' },
              { say: 'Develop the queenside knight and add pressure on d5.', move: ['b1c3'], reply: 'g8f6' },
              { say: 'Pin the knight that defends d5.', move: ['c1g5'], reply: 'f8e7',
                why: 'Black breaks the pin by placing the bishop between knight and queen.' },
              { say: 'Support your centre and open a path for the light-squared bishop.', move: ['e2e3'], reply: 'e8g8' },
              { say: 'Develop the last minor piece toward the centre.', move: ['g1f3'],
                why: 'Classic QGD set-up: every White piece is ready and both kings will soon be safe.' },
            ],
          }],
          outro: 'Queen\'s Gambit ideas: c4 to challenge d5, Nc3 and Bg5 to pressure it, then calm development.',
        },
        {
          id: 'op-sicilian', title: 'The Sicilian Defence', side: 'b',
          summary: 'Black\'s most popular reply to 1.e4: an unbalanced, fighting game.',
          parts: [{
            pre: ['e2e4'],
            intro: 'You play Black. The Sicilian fights for d4 with a flank pawn instead of copying White.',
            steps: [
              { say: 'Answer 1.e4 with the c-pawn two squares.', move: ['c7c5'], reply: 'g1f3',
                why: 'The c5 pawn controls d4 and keeps the position unbalanced.' },
              { say: 'A flexible pawn move: control e5 and open your bishop.', move: ['d7d6'], reply: 'd2d4' },
              { say: 'Trade your flank pawn for White\'s centre pawn.', move: ['c5d4'], reply: 'f3d4',
                why: 'Black now has two centre pawns against White\'s one: a long-term trump.' },
              { say: 'Develop with tempo: attack the e4 pawn.', move: ['g8f6'], reply: 'b1c3' },
              { say: 'The Najdorf move: control b5 and keep every option open.', move: ['a7a6'],
                why: 'This is the Najdorf, the favourite weapon of Fischer and Kasparov.' },
            ],
          }],
          outro: 'Sicilian ideas: ...c5, trade it for White\'s d-pawn, develop fast, and fight on the queenside.',
        },
        {
          id: 'op-scholar', title: 'Stopping Scholar\'s Mate', side: 'b',
          summary: 'Don\'t lose in four moves: defend f7 the right way.',
          parts: [{
            pre: ['e2e4'],
            intro: 'You play Black. Beginners often try the quick queen-and-bishop attack on f7. Let\'s refute it calmly.',
            steps: [
              { say: 'Take your share of the centre.', move: ['e7e5'], reply: 'f1c4' },
              { say: 'Develop your knight and defend e5.', move: ['b8c6'], reply: 'd1h5',
                why: 'White threatens Qxf7, which would be checkmate.' },
              { say: 'Stop the mate! Block the queen\'s path to f7 or defend f7.', move: ['g7g6', 'd8e7'], reply: 'h5f3',
                why: 'f7 is safe. White\'s queen tries again from f3, aiming at f7 once more.' },
              { say: 'Block the f-file with a developing move.', move: ['g8f6'],
                why: 'The knight blocks the attack and develops. White\'s early queen has wasted time, and Black is doing well.' },
            ],
          }],
          outro: 'Against early queen attacks: defend calmly, develop with tempo, and the queen becomes a target.',
        },
      ],
    },

    middlegame: {
      title: 'Middlegame',
      blurb: 'Tactics win games. Learn the patterns strong players spot instantly.',
      lessons: [
        {
          id: 'mg-fork', title: 'The knight fork', side: 'w',
          summary: 'One move, two attacks: win material with a fork.',
          parts: [{
            fen: 'r3k3/pp3ppp/8/3N4/8/8/PPP2PPP/4K3 w - - 0 1',
            intro: 'A fork attacks two pieces at once. Knights are the best forkers because their jump can\'t be blocked.',
            steps: [
              { say: 'Find a knight move that checks the king and attacks the rook at the same time.', move: ['d5c7'], reply: 'e8d7',
                why: 'Check! The king must move, and the rook on a8 is still attacked.' },
              { say: 'Collect the rook.', move: ['c7a8'],
                why: 'You won a whole rook. Always look for checks that also attack something.' },
            ],
          }],
          outro: 'Fork checklist: look for squares where one piece hits the king and another valuable piece.',
        },
        {
          id: 'mg-pin', title: 'The pin', side: 'w',
          summary: 'A pinned piece can\'t move. Attack it again.',
          parts: [{
            fen: '4k3/8/3p4/4n3/8/8/5P2/4R1K1 w - - 0 1',
            intro: 'Black\'s knight on e5 is pinned by your rook to the king: moving it would be illegal.',
            steps: [
              { say: 'The knight is defended by the d6 pawn, so don\'t take it with the rook. Attack it with a pawn instead.', move: ['f2f4'], reply: 'e8d7',
                why: 'The knight can\'t run because it is pinned. Black can only step the king aside.' },
              { say: 'Now win the knight.', move: ['f4e5'], reply: 'd6e5',
                why: 'You traded a pawn for a knight. When a piece is pinned, pile up on it!' },
            ],
          }],
          outro: 'Pins: attack the pinned piece with something cheaper. It can\'t run away.',
        },
        {
          id: 'mg-skewer', title: 'The skewer', side: 'w',
          summary: 'Attack the king, win the piece behind it.',
          parts: [{
            fen: '8/8/8/8/4k2q/8/8/R5K1 w - - 0 1',
            intro: 'A skewer is a reverse pin: you attack a valuable piece, and when it moves you win the piece behind it.',
            steps: [
              { say: 'Black\'s king and queen stand on the same rank. Check the king along that rank.', move: ['a1a4'], reply: 'e4d3',
                why: 'The king has to step off the rank, leaving the queen behind it undefended.' },
              { say: 'Take the queen.', move: ['a4h4'],
                why: 'Rook for nothing? Better: rook wins a queen. Watch for pieces lined up on the same line.' },
            ],
          }],
          outro: 'Skewers happen when two pieces share a rank, file or diagonal. Check the front one!',
        },
        {
          id: 'mg-discovered', title: 'Discovered attacks', side: 'w',
          summary: 'Move one piece to unleash another.',
          parts: [{
            fen: '7k/3q4/8/4N3/8/8/1B6/6K1 w - - 0 1',
            intro: 'Your bishop on b2 is aimed at Black\'s king, but your own knight is in the way.',
            steps: [
              { say: 'Move the knight with a capture: the bishop will give check at the same time.', move: ['e5d7'],
                why: 'Discovered check! Black has to deal with the check, so you simply won the queen.' },
            ],
          }],
          outro: 'Discovered attacks are deadly because the moving piece is free to grab something while the other piece checks.',
        },
        {
          id: 'mg-backrank', title: 'Back-rank mate', side: 'w',
          summary: 'Punish a king trapped behind its own pawns.',
          parts: [{
            fen: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1',
            intro: 'Black\'s king is boxed in by its own pawns. That is a classic weakness called a weak back rank.',
            steps: [
              { say: 'Deliver checkmate.', accept: 'mate', move: ['e1e8'],
                why: 'Checkmate on the back rank. The king\'s own pawns took away every escape square.' },
            ],
          }],
          outro: 'Defend your own back rank by giving your king an escape square (a "luft"), such as h3 or g3.',
        },
      ],
    },

    endgames: {
      title: 'Endgames',
      blurb: 'Convert your advantage: the checkmates and pawn endings every player must know.',
      lessons: [
        {
          id: 'eg-queen', title: 'Checkmate with a queen', side: 'w',
          summary: 'Finish the job, and don\'t stalemate!',
          parts: [
            { fen: '7k/8/6K1/8/8/8/8/5Q2 w - - 0 1',
              intro: 'King and queen against a lone king is always a win. The king helps by covering escape squares.',
              steps: [{ say: 'Checkmate in one move.', accept: 'mate', move: ['f1f8'],
                why: 'Your queen controls the back rank and your king covers g7 and h7.' }] },
            { fen: 'k7/8/1K6/8/8/8/8/7Q w - - 0 1',
              intro: 'Another king in the corner.',
              steps: [{ say: 'Checkmate in one move.', accept: 'mate', move: ['h1h8'],
                why: 'The queen checks along the rank while your king covers a7 and b7.' }] },
            { fen: 'k7/8/1K6/8/8/8/8/2Q5 w - - 0 1',
              intro: 'Careful! If you take away every square without giving check, it is stalemate: a draw.',
              steps: [{ say: 'Find the checkmate. Avoid Qc7, which would be stalemate.', accept: 'mate', move: ['c1c8'],
                why: 'Checkmate. Always make sure the defending king is in check when you take away its last squares.' }] },
          ],
          outro: 'Queen mates: push the king to the edge, bring your own king close, and watch for stalemate.',
        },
        {
          id: 'eg-rook', title: 'Checkmate with rooks', side: 'w',
          summary: 'The rook mates and the two-rook "ladder".',
          parts: [
            { fen: '6k1/8/6K1/8/8/8/8/R7 w - - 0 1',
              intro: 'With king and rook, the king takes away the squares in front and the rook delivers mate on the edge.',
              steps: [{ say: 'Checkmate in one.', accept: 'mate', move: ['a1a8'],
                why: 'The kings stand face to face, so the rook can mate along the back rank.' }] },
            { fen: '4k3/8/8/8/8/8/R7/1R4K1 w - - 0 1',
              intro: 'Two rooks mate without any help from the king: one cuts off a rank, the other checks.',
              steps: [
                { say: 'Cut the king off: put a rook on the 7th rank.', move: ['a2a7'], reply: 'e8d8',
                  why: 'Black\'s king is now stuck on the 8th rank.' },
                { say: 'Deliver checkmate with the other rook.', accept: 'mate', move: ['b1b8'],
                  why: 'The ladder mate: one rook guards the 7th rank, the other checks on the 8th.' },
              ] },
          ],
          outro: 'Rook mates always happen on the edge of the board. Use rooks to build walls.',
        },
        {
          id: 'eg-square', title: 'Run, pawn, run!', side: 'w',
          summary: 'The "rule of the square": can the king catch your pawn?',
          parts: [{
            fen: '8/8/8/8/8/k7/6P1/6K1 w - - 0 1',
            engine: false, endsWith: 'promotion',   // win is beyond engine depth; the check below confirms the line queens
            intro: 'Imagine a square from your pawn to the promotion rank. If the enemy king can\'t step inside it, the pawn queens on its own.',
            steps: [
              { say: 'Black\'s king is far outside the square. Push the pawn two squares.', move: ['g2g4'], reply: 'a3b4' },
              { say: 'Keep running.', move: ['g4g5'], reply: 'b4c5' },
              { say: 'Keep going: the king is still too slow.', move: ['g5g6'], reply: 'c5d6' },
              { say: 'One more step.', move: ['g6g7'], reply: 'd6e7' },
              { say: 'Promote to a queen!', move: ['g7g8q'],
                why: 'A new queen. The king was outside the square, so it could never catch the pawn.' },
            ],
          }],
          outro: 'Rule of the square: if the defending king is outside the pawn\'s square (and it\'s your move), just push.',
        },
        {
          id: 'eg-opposition', title: 'King and pawn: the opposition', side: 'w',
          summary: 'Use your king to escort a pawn to promotion.',
          parts: [{
            fen: '4k3/8/3K4/4P3/8/8/8/8 w - - 0 1',
            engine: false, endsWith: 'promotion',   // win is beyond engine depth; the check below confirms the line queens
            intro: 'When kings face each other with one square between them, the side NOT to move "has the opposition". Use it to push the enemy king aside.',
            steps: [
              { say: 'Step in front of your pawn and take the opposition.', move: ['d6e6'], reply: 'e8d8',
                why: 'Black must give way: the king steps aside.' },
              { say: 'Take control of the promotion square with your king.', move: ['e6f7'], reply: 'd8d7',
                why: 'Your king now guards e8, e7 and e6: the pawn\'s whole path.' },
              { say: 'Push the pawn with check.', move: ['e5e6'], reply: 'd7d6' },
              { say: 'Keep pushing.', move: ['e6e7'], reply: 'd6d7' },
              { say: 'Promote: your king protects the new queen.', move: ['e7e8q'],
                why: 'Promotion! King in front of the pawn plus the opposition is the key to winning these endings.' },
            ],
          }],
          outro: 'King and pawn endings: get your king in front of the pawn, take the opposition, then push.',
        },
      ],
    },
  };
  if (typeof module === 'object' && module.exports) module.exports = COURSES;
  else root.COURSES = COURSES;
})(typeof self !== 'undefined' ? self : this);
