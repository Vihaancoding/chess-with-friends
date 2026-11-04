// The fallback bank for The Damage Report: lines used when the AI is down, slow or rejected. Each one is a template
// filled with real numbers from the game and only used when what it talks about actually happened:
//   gen      always fits          queen    the queen was lost for nothing     hung     a piece was hung
//   fork     walked into a fork   blunders 2 or more blunders by the loser    mmL      the loser missed a mate
//   mmW      the winner missed a mate (and won anyway)                         mate     checkmate
//   early    mate on move 22 or sooner          king   the king was chased      tactic   a fork or sacrifice the engine confirms
//   resign / timeout   how it ended   long (45+ moves) / short (25 or fewer)   lead     a big material lead   lost   4+ pieces gone
// Tokens: {w} winner, {l} loser, {moves}, {qm} queen move, {surv} moves survived after it, {hm} {hp} the hung piece,
// {fm} fork move, {bn} blunder count, {mn} {mm} missed mate in n on move m, {ck} checks, {km} king moves, {tm} {tk} the
// tactic and its kind, {lead} material points, {lost} pieces lost, {down} {lowm} (comebacks) pawns down and when.
// Written to be read like a mate in a group chat: no pronouns for people, no dashes, no colons, nothing that explains itself.
const BANK = {
  slight: {
    gen: [
      '{w} wins in {moves} moves. {l} will say it was closer than that.',
      'Nobody got humiliated here. {l} just lost slowly, over {moves} moves.',
      '{moves} moves and {l} never really got hold of this one. No shame, plenty of questions.',
      'A tidy win for {w} after {moves} moves. {l} was there, technically.',
      '{l} fought for {moves} moves and then stopped, which is one way to finish a game.',
      'Mildly rude result. {w} wins in {moves} moves of patient annoying.',
      '{moves} moves of {l} treating the opening like a suggestion.',
      'Worst part of {l}\'s day was probably these {moves} moves.',
    ],
    queen: [
      '{l} lost the queen on move {qm} and played {surv} more moves. Commitment, of a sort.',
      'The queen left on move {qm}. {l} stayed another {surv} moves out of politeness.',
      'Losing the queen on move {qm} is a choice. Playing on for {surv} more moves is a second choice.',
      'Queen gone on move {qm}. {l} kept the rest of the pieces for emotional support.',
      '{l} gave away the queen on move {qm} and called the remaining {surv} moves a plan.',
    ],
    hung: [
      'Move {hm}, {l} left a {hp} out for anyone to take. {w} took it.',
      '{l} hung a {hp} on move {hm} and the rest of the game was paperwork.',
      'A {hp} walked off for free on move {hm}. Good for the {hp}, bad for {l}.',
      '{l} put a {hp} on a square where it could be eaten, on move {hm}. It was eaten.',
      'On move {hm} the {hp} was just sitting there. {w} is not made of stone.',
    ],
    fork: [
      '{l} walked into a fork on move {fm}. The pieces had a quiet word afterwards.',
      'Move {fm}, fork. {l} saw it exactly one move too late.',
      'Fork on move {fm}. {l} looked at the board like it was a surprise party.',
    ],
    blunders: [
      '{bn} blunders in {moves} moves from {l}. At that point it is a style.',
      '{l} blundered {bn} times and still made {w} work for it. Respect, sort of.',
      '{bn} blunders. {w} only needed the one.',
      'Count them. {bn} blunders from {l}, and the game still took {moves} moves.',
    ],
    mmL: [
      '{l} had mate in {mn} on move {mm} and did not play it. Did not even look at it.',
      'Mate in {mn} was on the board at move {mm}. {l} played something else, probably out of curiosity.',
      '{l} missed mate in {mn} on move {mm} and then lost. Cruel, but the mate was right there.',
    ],
    mmW: [
      '{w} missed mate in {mn} on move {mm} and won anyway. {l} did the rest.',
      'Mate in {mn} on move {mm} and {w} walked right past it. Won anyway, so nobody can complain.',
      '{w} skipped a mate in {mn} on move {mm}. Winning the long way round.',
    ],
    mate: [
      'Checkmate on move {moves}. {l} saw it coming only when it arrived.',
      '{w} mates on move {moves}. Clean enough, if you ignore how it got there.',
      'Mated on move {moves}. {l} will blame the lag.',
      '{moves} moves, then mate. {l} went out politely.',
    ],
    early: [
      'Mated on move {moves}. The coffee had not even cooled.',
      'Checkmate in {moves} is early. {l} barely got the pieces warm.',
      '{moves} moves to get mated. {l} gave the opening theory a day off.',
    ],
    king: [
      '{ck} checks and {km} king moves. {l}\'s king got a full tour it did not ask for.',
      '{l}\'s king walked {km} times while {w} kept the checks coming. Cardio.',
      'The king ran {km} times and still got caught. {w} gave {ck} checks to make sure.',
    ],
    tactic: [
      'A {tk} from {w} on move {tm} and the game was over in spirit.',
      '{w} played a {tk} on move {tm} that the engine signed off on. {l} was not consulted.',
      'Move {tm}, {w} drops a {tk}. {l} just stood there.',
    ],
    resign: [
      '{l} resigned after {moves} moves. Fair, honestly.',
      '{l} resigned on move {moves}, which was the best move in a while.',
      'Resigned on move {moves}. {l} read the room.',
    ],
    timeout: [
      '{l} ran out of time on move {moves}. The position was not the only thing running out.',
      'Lost on the clock on move {moves}. {l} thought about it too much and then not enough.',
    ],
    long: [
      '{moves} moves of this. {l} deserves a medal and a lie down.',
      '{w} needed {moves} moves, so call it a long walk with a happy ending.',
      'A {moves} move grind. {l} never gave up and never got anywhere.',
    ],
    short: [
      'Over in {moves} moves. {l} did not even get to settle in.',
      '{moves} moves total. Short enough that {l} can claim the opening was theory.',
    ],
    lead: [
      'Up {lead} points of material by the end. {l} is basically doing charity.',
      '{w} finished {lead} points up. {l} gave generously.',
    ],
    lost: [
      '{l} lost {lost} pieces over the game. Somebody was keeping count and it was not {l}.',
      '{lost} pieces gone from {l}\'s side. The board looked like a yard sale.',
    ],
  },
  dominant: {
    gen: [
      '{w} by {moves} moves of calm, quiet bullying.',
      '{l} was in this game for {moves} moves and never once looked comfortable.',
      '{moves} moves. {l} spent most of them looking for a plan and the rest looking for the exit.',
      '{w} controlled that from the first few moves. {l} mostly watched.',
      'No drama, no mercy. {w} wins in {moves} moves.',
      '{l} had {moves} moves to do something and used them to think about it.',
      'A proper beating without any theatre. {moves} moves, {w} on top the whole way.',
      '{moves} moves, and {l} was playing a different game to {w}. A worse one.',
    ],
    queen: [
      '{l} lost the queen on move {qm} and the next {surv} moves were just manners.',
      'Move {qm}, queen gone. {l} played {surv} more moves like nothing had happened.',
      'No queen from move {qm} onwards. {l} found {surv} more ways to be disappointed.',
      '{l} gave up the queen on move {qm} and still showed up for {surv} more moves. Dedication.',
      'Queen down on move {qm}. After that {l} was a spectator with a keyboard.',
    ],
    hung: [
      'A {hp} just left on move {hm} and {l} watched it go. {w} said thanks.',
      'Move {hm}. {l} hangs a {hp}, {w} accepts, nobody asks questions.',
      '{l} left a {hp} undefended on move {hm}. Free {hp}, no coupon needed.',
      'On move {hm} {l} found a square for the {hp} and it was the wrong one.',
      'A {hp} hung on move {hm}. {l} treated it like a donation.',
    ],
    fork: [
      '{l} walked into a fork on move {fm}. The fork had been waiting.',
      'Fork on move {fm}. Two pieces looked at each other and then at {l}.',
      'Move {fm} brought the fork and {l} brought the surprise.',
    ],
    blunders: [
      '{bn} blunders from {l} in {moves} moves. {w} just kept the receipts.',
      '{l} blundered {bn} times. {w} accepted all of them, which is polite.',
      '{bn} blunders. At some point it is just generosity.',
      '{bn} blunders in a {moves} move game. {l} is a very giving person.',
    ],
    mmL: [
      '{l} had mate in {mn} on move {mm} and played something else. Interesting choice.',
      'Mate in {mn} sat on the board at move {mm}. {l} walked past it like a billboard.',
      '{l} could have mated in {mn} on move {mm}. Instead the game went the usual way.',
    ],
    mmW: [
      '{w} missed mate in {mn} on move {mm}, then won anyway. Showing off.',
      'Move {mm} had a mate in {mn} and {w} ignored it. Still won, still rude.',
      '{w} skipped mate in {mn} on move {mm} and won later. Nobody was in a hurry.',
    ],
    mate: [
      'Mate on move {moves}. {l} got to find out what the end of the game looks like.',
      '{w} checkmates on move {moves} and {l} gets a lovely view of it.',
      'Checkmate after {moves} moves. {l} helped.',
      '{moves} moves to get mated. {l} might want a second opinion on that opening.',
    ],
    early: [
      'Mated on move {moves}. {l} left the opening book at home.',
      'Checkmate in {moves}. No middlegame, just a drive through.',
      '{moves} moves and it is mate. {l} did not see the sequel.',
    ],
    king: [
      '{ck} checks and {km} king moves. {l}\'s king had a long evening.',
      '{w} chased the king for {ck} checks. {l} made it run {km} times.',
      'The king ran {km} times and {w} still found {ck} checks. Properly exhausting.',
    ],
    tactic: [
      '{w} dropped a {tk} on move {tm} and the game stopped being a contest.',
      'A {tk} on move {tm}. {l} will be looking at that one for days.',
      'Move {tm}, {w} plays a {tk}. {l} politely nods.',
    ],
    resign: [
      '{l} resigned on move {moves}. The right call, a little late.',
      '{l} clicked resign after {moves} moves. Overdue by a few.',
      'Resigned on move {moves}. {l} finally agreed with the evaluation.',
    ],
    timeout: [
      '{l} lost on time on move {moves}, which saved {w} from finishing the job.',
      'The clock got {l} on move {moves}. Everything else was already losing.',
    ],
    long: [
      '{moves} moves of {w} sitting on top of {l}. Impressive dedication from both.',
      '{l} lasted {moves} moves. Resilience or denial, hard to tell.',
      'A {moves} move squeeze. {l} felt every single one of them.',
    ],
    short: [
      'Done in {moves} moves. {l} was barely in the building.',
      '{moves} moves and it was already sorted. {w} had somewhere to be.',
    ],
    lead: [
      '{w} ended {lead} points up. {l} was running a charity.',
      '{w} finished {lead} points of material up. {l} finished with a story.',
    ],
    lost: [
      '{l} watched {lost} pieces leave. It was a short guest list by the end.',
      '{lost} pieces lost for {l} and nothing to show for it.',
    ],
  },
  brutal: {
    gen: [
      '{w} took {l} apart in {moves} moves. Absolute fucking clinic.',
      '{moves} moves of {l} getting shoved around the board. Painful to watch.',
      '{l} played {moves} moves and every one of them made it worse.',
      '{moves} moves of {w} doing whatever they wanted. {l} was furniture.',
      '{l} got absolutely cooked in {moves} moves.',
      '{w} demolished {l} in {moves} moves and barely looked up.',
      '{moves} moves and every phase of the game went badly for {l}. Impressive in its own way.',
      '{l} is going to need a minute after those {moves} moves.',
    ],
    queen: [
      'Queen gone on move {qm} and {l} kept playing for {surv} more moves. Delusional.',
      '{l} lost the queen on move {qm} and somehow thought {surv} more moves would help.',
      'Queen off on move {qm}. The next {surv} moves were {l} refusing to read the room.',
      'No queen from move {qm}. {l} still made {surv} more moves, which is fucking brave.',
      'Move {qm}, queen dead. {l} then spent {surv} moves proving it was no fluke.',
    ],
    hung: [
      '{l} hung a {hp} on move {hm}. Gave it away like a free sample.',
      'Move {hm}, {hp} hung. {l} treats pieces like they grow back.',
      'A free {hp} on move {hm}. {w} said thanks and ate it.',
      '{l} hung a {hp} on move {hm} and then acted like the game was still on.',
      'A {hp} left on the house on move {hm}. {l} is running a buffet.',
    ],
    fork: [
      '{l} walked into a fork on move {fm}. Fucked from there.',
      'Fork on move {fm}. {l} stared at the board like it had personally lied.',
      'Move {fm} and the fork arrived. {l} had every chance to see it and chose not to.',
    ],
    blunders: [
      '{bn} blunders in {moves} moves from {l}. The board was taking donations.',
      '{l} blundered {bn} times. {w} stopped counting and started collecting.',
      '{bn} blunders. {w} won and {l} helped on every one.',
      '{bn} blunders this game. {l} is cooked.',
    ],
    mmL: [
      '{l} had mate in {mn} on move {mm} and played something else. Pure cinema, the bad kind.',
      'Mate in {mn} sat there on move {mm}. {l} ignored it and lost anyway, fucking tragic.',
      '{l} could have mated in {mn} on move {mm}. Instead {l} chose pain.',
    ],
    mmW: [
      '{w} missed mate in {mn} on move {mm} and still destroyed {l}. Overkill with extra steps.',
      'Mate in {mn} on move {mm}. {w} skipped it and won anyway because {l} was never going to fight back.',
      '{w} had mate in {mn} on move {mm} and took the scenic route. {l} still got flattened.',
    ],
    mate: [
      'Mated on move {moves}. {l} never stood a fucking chance.',
      'Checkmate after {moves} moves. {l} got folded like a deck chair.',
      '{moves} moves and {w} mates. {l} got absolutely rinsed.',
      '{w} mates on move {moves}. {l} should go outside for a bit.',
    ],
    early: [
      'Mated on move {moves}. The opening had not finished loading.',
      'Checkmate in {moves}. {l} lasted shorter than the loading screen.',
      '{moves} moves is how long {l} survived. Even the intro to a podcast is longer.',
    ],
    king: [
      '{ck} checks and {km} king moves. {w} chased that king round the board like a fucking sheepdog.',
      'The king ran {km} times. {w} gave {ck} checks and it ran out of road.',
      '{l}\'s king got hunted for {ck} checks and {km} desperate moves. Savage.',
    ],
    tactic: [
      '{w} cracked out a {tk} on move {tm}. {l} was done and had not been informed.',
      'Move {tm}, {tk}. {l} watched the whole game fall apart in one move.',
      'A {tk} on move {tm} and {l} was cooked.',
    ],
    resign: [
      '{l} resigned on move {moves}. Merciful, for everybody.',
      'Resigned on move {moves}. {l} finally stopped the bleeding.',
      '{l} took {moves} moves to hit resign. The position had been dead for a while.',
    ],
    timeout: [
      '{l} lost on time on move {moves}. The position was already a corpse, the clock just closed the casket.',
      'Flagged on move {moves}. {l} had nothing left on the clock or the board.',
    ],
    long: [
      '{moves} moves of {l} getting ground to dust. Slow, deliberate, awful.',
      '{l} lasted {moves} moves and got flattened for every one of them.',
      'It took {moves} moves but {w} got there. {l} suffered through all of them.',
    ],
    short: [
      'Done in {moves} moves. {l} got shot before the first drink.',
      '{moves} moves and that is it. {l} got a speeding ticket on the way to the endgame.',
    ],
    lead: [
      '{lead} points of material up by the end. {l} got robbed in broad daylight.',
      '{w} finished {lead} points ahead. {l} was just the donor.',
    ],
    lost: [
      '{l} lost {lost} pieces. The board looked like a crime scene.',
      '{lost} pieces gone from {l}\'s side. Somebody check for a pulse.',
    ],
  },
  complete: {
    gen: [
      '{w} dragged {l} through {moves} moves like a shopping trolley with a bad wheel.',
      '{moves} moves and {l} left with less than they came with. Total fucking annihilation.',
      'Scorched earth. {moves} moves and {l} will be explaining this one to a therapist.',
      '{w} took {moves} moves to leave {l} with absolutely nothing. A new low in generosity.',
      '{l} played {moves} moves and the board is filing a complaint.',
      'Nobody survives {moves} moves of that. {l} did barely and regrets it.',
      '{w} unplugged {l} in {moves} moves. Crime scene tape is still up.',
      'If this game had a sound it was a fucking scream. {moves} moves, total wipeout.',
    ],
    queen: [
      'Move {qm}, the queen is dead. {l} still showed up for {surv} more moves like a ghost with wifi.',
      '{l} lost the queen on move {qm} and then lived through {surv} more moves. A war crime against the game.',
      'The queen died on move {qm}. {surv} moves later {l} was still pushing pieces, which is sad theatre.',
      'Move {qm} and the queen is in the bin. {l} played {surv} more moves like nobody had said a word.',
      'Queen vanishes on move {qm}. {l} spent the next {surv} moves in pure denial.',
    ],
    hung: [
      '{l} hung a {hp} on move {hm}. That {hp} is on a milk carton now.',
      'Move {hm}, {l} gift wraps a {hp} and hands it over. {w} did not even have to ask.',
      'A {hp} hung on move {hm}. The {hp} has filed for emotional damages.',
      '{l} left a {hp} out on move {hm} like a fucking bake sale.',
      'The {hp} was free on move {hm}. {l} was the only one who did not know.',
    ],
    fork: [
      'Fork on move {fm}. {l} walked into it like a moth into a very specific lamp.',
      'Move {fm}, fork. {l} had a whole game to avoid it and still found it.',
      'A fork on move {fm} and {l}\'s position left the group chat.',
    ],
    blunders: [
      '{bn} blunders and {l} kept going like a haunted vending machine.',
      '{bn} blunders. {w} did not win this, {l} signed it over.',
      '{l} made {bn} blunders in {moves} moves. Somebody call the hotline.',
      '{bn} blunders. The board has requested a restraining order.',
    ],
    mmL: [
      'Mate in {mn} sat on move {mm} like a gift. {l} threw it in the bin and went on to lose.',
      '{l} had mate in {mn} on move {mm}. Instead, absolute fucking chaos.',
      'Move {mm}, mate in {mn} on offer. {l} said no and the universe laughed.',
    ],
    mmW: [
      '{w} missed mate in {mn} on move {mm} and still killed {l} stone dead. Showboating.',
      'Mate in {mn} was there on move {mm}. {w} did not need it and won anyway, disgusting.',
      '{w} walked past mate in {mn} on move {mm} and still ended it. {l} never stood a chance.',
    ],
    mate: [
      'Checkmate on move {moves}. {l} got deleted.',
      '{w} mates on move {moves}. {l} has been sent to the shadows.',
      'Mate after {moves} moves. The board is still ringing.',
      '{moves} moves, then checkmate. {l} was last seen running.',
    ],
    early: [
      'Mated on move {moves}. {l} went from boot up to blue screen in no time.',
      'Checkmate in {moves}. {l} got speedrun any percent and the record stands.',
      '{moves} moves to mate. {l} was in and out before anyone pulled up a chair.',
    ],
    king: [
      '{ck} checks and {km} king moves. {l}\'s king was hunted like a fucking pinata.',
      '{w} hunted that king with {ck} checks. It ran {km} times and still got caught like a pigeon.',
      '{l}\'s king got {ck} checks and {km} desperate steps. A nature documentary with a bad ending.',
    ],
    tactic: [
      'A {tk} on move {tm} and {l}\'s position left the planet.',
      '{w} pulled a {tk} on move {tm}. {l} got turned into soup.',
      'Move {tm}, {tk}. {l} has been in therapy since.',
    ],
    resign: [
      '{l} resigned on move {moves}. The board gave a standing ovation, mostly out of pity.',
      'Resigned on move {moves}. {l} left the room without a goodbye.',
      '{l} hit resign on move {moves} and the pieces were genuinely relieved.',
    ],
    timeout: [
      'Flagged on move {moves}. {l} ran out of clock and ideas at the same time.',
      '{l} got flagged on move {moves}. The clock was merciful and the position was not.',
    ],
    long: [
      '{moves} moves of {l} being dismantled like flat pack furniture.',
      '{moves} moves. {w} took {l} apart screw by screw and kept the instructions.',
      'A {moves} move beating. {l} got all of it, tip included.',
    ],
    short: [
      'Over in {moves} moves. {l} got in, got wrecked, got out.',
      '{moves} moves. {l} met a chessboard like a car meets a wall.',
    ],
    lead: [
      '{lead} points up. {l} got turned into a fucking donation box.',
      '{w} finished {lead} points up and {l} got fleeced.',
    ],
    lost: [
      '{lost} pieces gone from {l}\'s side. Fire sale, everything must go.',
      '{lost} pieces wiped off the board for {l}. Smoke is still rising.',
    ],
  },
  comeback: {
    gen: [
      '{w} was down {down} on move {lowm} and still won. {l} had one job.',
      'Down {down} pawns on move {lowm}. {w} won in {moves} moves anyway and {l} will think about that for a week.',
      '{l} was winning on move {lowm}. {w} won on move {moves}, so something happened in between.',
      '{w} came back from {down} down on move {lowm} and {l} watched the lead evaporate.',
      'Move {lowm}, {w} was down {down}. Move {moves}, {l} was done, fucking stretch of chess.',
      '{l} had a winning position on move {lowm} and handled it like a hot pan.',
      '{down} down on move {lowm} and {w} just kept going. {l} blinked first.',
      'The comeback took {w} from {down} behind to a win by move {moves}. {l} still has the screenshots.',
      '{l} was {down} up on move {lowm} and somehow lost by move {moves}. Stunning.',
      '{w} was cooked on move {lowm} and ended up cooking {l} instead.',
      '{w} was dead on move {lowm}, down {down}. Nobody told them and they just kept playing.',
      '{l} had {down} points to play with on move {lowm} and finished with none of them.',
      'A {down} point deficit on move {lowm} and {w} still won. {l} found a way to give it all back.',
      '{w} was down {down} on move {lowm} and {l} thought the hard part was over. It was not.',
      '{l} led by {down} on move {lowm} and finished {moves} moves later with nothing to show.',
      'Move {lowm}, {w} looked finished. Move {moves}, {l} was the one staring at the screen.',
      '{w} sat {down} down on move {lowm} and stayed calm. {l} did the panicking for both.',
      '{down} points up on move {lowm} and {l} still lost. There is a bin for that kind of lead.',
      '{l} had the game on move {lowm}, {down} up. {w} took it back by move {moves}, politely.',
      'Somewhere between move {lowm} and move {moves} this game flipped, and {l} was left holding the wrong end.',
      '{w} was dead and buried on move {lowm}, {down} down. {l} forgot to check for a pulse.',
      '{moves} moves, and {down} down on move {lowm}. {w} did not read the room and won it anyway.',
      '{l} got {down} up and decided that was enough work for one game.',
      'Down {down} on move {lowm}. {w} just kept making moves and {l} kept making worse ones.',
      '{l} turned a {down} point lead on move {lowm} into a loss by move {moves}. Takes talent.',
      '{w} dug out of a {down} point hole by move {moves}. {l} handed over the shovel.',
      'You do not usually get to be {down} up and lose, but {l} made it look easy.',
      '{w} was a long way behind on move {lowm}. The scoreboard says {moves} moves and a win anyway.',
      '{l} sat on a {down} point lead on move {lowm} and let it melt in their hands.',
    ],
    mate: [
      '{w} was down {down} on move {lowm} and finished with checkmate on move {moves}. Cold.',
      'From {down} down to mate on move {moves}. {l} threw a winning game away.',
      'Mate on move {moves} after being down {down} on move {lowm}. {l} had the game in the bag and dropped the bag.',
      '{l} got mated on move {moves} from a position that was {down} up on move {lowm}. Painful.',
      'Checkmate on move {moves}, and on move {lowm} {l} was {down} to the good. Make it make sense.',
      '{w} mates on move {moves} after sitting {down} down on move {lowm}. Somebody owes {w} an apology.',
      'Mate on move {moves}. {down} down on move {lowm} and {w} still got the last word.',
      '{l} was {down} up on move {lowm} and got mated on move {moves}. That is a long way to fall.',
    ],
    resign: [
      '{l} resigned on move {moves} after being {down} up on move {lowm}. Brutal.',
      'Down {down} on move {lowm}, win on move {moves}. {l} resigned a game they were winning.',
      '{l} resigned on move {moves}. On move {lowm} that position was {down} up for {l}.',
      '{l} clicked resign on move {moves} from a game that was {down} up for them on move {lowm}.',
      'Resigned on move {moves}. {w} was {down} down on move {lowm} and {l} still folded first.',
      '{l} resigned on move {moves}. The {down} point lead from move {lowm} is long gone and so is the game.',
    ],
    timeout: [
      '{l} flagged on move {moves} from a position {down} up on move {lowm}. Thrown away on the clock.',
      '{w} was {down} down on move {lowm} and won on time on move {moves}. The clock did the last bit.',
      'Flagged on move {moves}. {l} was {down} to the good on move {lowm} and had no time to enjoy it.',
      'Flagged on move {moves}. {down} up on move {lowm}, and the clock still beat {l}.',
    ],
    long: [
      '{moves} moves, one big swing and {w} on top at the end. {l} had {down} up on move {lowm}.',
      'Long game, {moves} moves. {w} came out ahead from {down} down while {l} had the lead and not the nerve.',
      '{moves} moves of back and forth. {w} was {down} down on move {lowm} and still got there.',
      'It took {moves} moves but {w} dug out of a {down} point hole. {l} watched it happen.',
      '{moves} moves and a {down} point swing since move {lowm}. {l} will want a word with their past self.',
    ],
    short: [
      'Only {moves} moves and {w} flipped a {down} down game. {l} spent the lead fast.',
      '{w} turned {down} down on move {lowm} into a win by move {moves}. Quick comeback.',
      '{moves} moves total and {l} went from {down} up on move {lowm} to losing. That is fast.',
      'Only {moves} moves, and {l} still found time to blow a {down} point lead from move {lowm}.',
    ],
  },
};

const NEEDS = {
  gen: [], queen: ['queen'], hung: ['hung'], fork: ['fork'], blunders: ['blunders'], mmL: ['mmL'], mmW: ['mmW'],
  mate: ['mate'], early: ['mate', 'early'], king: ['king'], tactic: ['tactic'], resign: ['resign'], timeout: ['timeout'],
  long: ['long'], short: ['short'], lead: ['lead'], lost: ['lost'],
};

// flatten to [{ id, band, type, need, s }]
const TEMPLATES = [];
for (const [band, types] of Object.entries(BANK))
  for (const [type, lines] of Object.entries(types))
    lines.forEach((s, i) => TEMPLATES.push({ id: `${band}.${type}.${i}`, band, type, need: NEEDS[type] || [], s }));

module.exports = { BANK, NEEDS, TEMPLATES };
