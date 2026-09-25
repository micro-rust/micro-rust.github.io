+++
title = "Building a DMA based driver for the RP2350 I2C (safety not included)"
date = 2026-09-23
description = "Describing the build process for an efficient DMA based I2C driver for the RP2350 microcontrollers."

[taxonomies]
tags = ["embedded", "driver", "i2c", "low-level"]
+++

The RP2350 I2C implementation has always been a bit quirky and, so far, I've yet to see an efficient implementation that uses DMA to offload the transactions of this peripheral. In this blog post I will give an overview of the problem and how I solved it in my personal RP2350 HAL.

<!-- more -->

## What and why?

If you don't know the RP2350, it's a small _newish_ microcontroller from the Raspberry Pi foundation. The main information we care about for this post is: it has **2 x Cortex M-33** CPU cores (quite powerful **and** with atomics), around 512 kiB of local SRAM (more than we will need) and a very... _peculiar_ I2C implementation form Synopsis.

The implementation from synopsis requires 16 bit writes and reads to manage 8 bit sized words on the I2C lines, making it very unwieldy to manage from a DMA perspective, especially because it requires set bits in the top half of the 16 bit word for flow control in the I2C bus.

As for why I want to implement this? Well, the current way to use this I2C peripheral in an async context is the [embassy](https://github.com/embassy-rs/embassy) RP2350 HAL, which only handles I2C traffic (as of this blog post) via IRQ notifications and CPU intervention. One of the main issues I have with this approach is that the flow of data can be easily disrupted with this workflow. The embassy crate handles all data transactions within async `Future`s and that makes it heavily dependent on timely execution of those `Future`s. If they are interrupted (by IRQs) or delayed (by being far off in the `Executor`'s queue) the `Future`s will hold the bus, slowing down the traffic or producing timeouts in downstream peripherals.

I'll also take this chance to go in a different direction as `embassy` in a couple of aspects that have annoyed me for a long time. First one, which can be considered a more of a pet peeve, is the freaking types. Types here, types there, types as long as my screen. `embassy` is a strongly typed framework and, even when it is solving many things about correctness, once you are 3 or 4 abstraction layers over it your types become unbearable. One solution for this is to use `dyn Trait` and indirection, but those force you to either reach for `alloc` or use `dyn` which can get unwieldy and annoying (or in the case of `alloc` even against your design guides), specially because we are in an embedded context.

After I decided to erase the types as much as I could, I decided there was no reason to not make all the I2C handling types be cross core, so any of the two cores of the application could manage traffic in the I2C bus. In the end, the way you divide tasks in you application does not always need to be "_all I2C tasks to the left, the rest to the right_", but you should be able to split them as you wish (even if **I myself** do distribute the tasks like that in most of my applications).

> [!NOTE]
> I am not disparaging the work of the `embassy` team in no way or saying they've done a bad job, just that their philosohy and priorities differ in the goals of our respective HALs.

## Getting the infrastructure in place

I will not dwell long in this step, as I plan to make different posts for these part of my HAL, but just give a quick overview of what prior work there is that enables the creation of the I2C driver.

So, now, what tools do we need? First, we are going to interact with the IRQ system, so a way to set IRQ handlers for the cores. We also want to use DMA, so we need a reliable but simple to use abstraction of the DMA subsystem. We will need to control the `GPIO`s to use the pins for I2C. And last we need a system to share or enqueue (_wink wink_) between the cores, so we will use a multicore compatible descriptor queue.

| Building block   | Already done | Blog post |
|------------------|--------------|-----------|
| IRQ dispatch     | yes          | Not yet   |
| GPIO control     | yes          | Not yet   |
| DMA subsystem    | yes          | Not yet   |
| Multicore queue  | yes          | Not yet   |
| I2C driver       | no           | This one  |

## But first, the backup plan

DMA is fine and dandy, but its main issue is that it will require some sort of buffer to stage the 8 bit to 16 bit parts (and in reverse). So until we figure that out we will just implement our own IRQ based driver (also we will use this to understand the I2C peripheral).

I started by implementing the boring part, get the peripheral singleton `I2CPeripheral<const N: usize>` (`N` is just a `const` generic to avoid reimplementing two types of `I2CPeripheral`s), set the I2C configuration and timings (in this case it supports `Standard`, `Fast` and `Fast+` modes) and once configured we consume the `GPIO`s that will be used as well as "_transmute_" the `I2CInstance<N>` into a type erased `I2CDevice` (we use small runtime dispatch to route the requests to the correct peripehral). Now this `I2CDevice` is the one that will actually interact with the I2C bus and whoever is attached to it.

To avoid the issues of handling the data in the Thread mode `Future`s, we will push as much I2C handling logic to the IRQ as possible. This goes a bit agains the philosophy of keeping the IRQs as small as possible, but with good design and optimizations I believe I can make it work in a reasonable time. I aim to handle the IRQ in the order of 100 - 1000 cycles, which at a speed of 150 MHz of the RP2350 would mean the time spend in the IRQ between less than a microsecond to around 70 microseconds.

And, please forgive me, but I will also commit the cardinal sin of using local `static mut`s for storing the internal state of the IRQ. Yes, I know there are ways in Rust to make this kind of access safe, but, honestly, we are in an IRQ, we are almost as low level as can be, rules here are more of... guidelines, and I will treat them as such. Specially because I will not let a bad `Option` or `Mutex` state to mess with the IRQ time. Once we arm the IRQ to trigger it will always have all the data / information it needs to handle a transfer.

> [!IMPORTANT]
> Please never, ever, in the never, use a `Mutex` in an IRQ. I will die and haunt you as a ghost. Also, never use an `Option` to hold state back from an IRQ. These two could easily lead to blocking loops in the device (although they would be very safe loops).

## Coding the IRQ path

Wohooo, time to code! So, what are we coding first, the IRQ of the `Future` path? Well, the way I see it, the IRQ is the more critical one, as it has both less flexibility of what tools we can use and stricter time constraints. So the IRQ it is. As I'm a lazy ass, I will only program one IRQ and just use the IRQ entry vector to do a trampolin to the real `handler` function, passing the related I2C instance as an index. Simple, reduces code duplication and, in the end, does not impact performance much, as we compute indices of the peripheral only once at the start.

Once the "_real_" IRQ enters, the only information we have is which I2C instance we are serving but we know nothing about what data we are transfering, what's the current state of the transfer or anything else. So, first things first: What in the heck are we transfering? Is it an empty transaction? Are we reading? Writing? Just fiddling our thumbs? Well, to solve this we are going to use one of the previously done building blocks, the multicore `Queue`.

This `Queue` abstraction (simple linked list, basic AF) has an (`unsafe`) method of getting the current **active** node, the one that has triggered the current transfer. So obviously, get that first. With this we now have a `I2CTransfer` object, which will contain references (don't even ask about the validity of these references, it will make the borrow checker cry[^1]) to the list of operations (`Read` and `Write`) to perform and their data. It will also contain a specific field to communicate to it if there were any errors (a simple `Option<I2CError>`) and a _gasp_ **shared mutable state flags** (_insert background horror music_). The way the state transition is kept safe is by a contract between the `I2CTransfer` `Future` and the IRQ. Same as described before, the `I2CTransfer` can touch the data **only** up to the point where the IRQ is armed and can be triggered. After that point **only the IRQ** can modify the state, up to a point where it gives back control to the `I2CTransfer` and wakes it.

```text
 <.await>    ┌─────────┐  <wait>     ┌───────────┐  <trigger>   ┌────────────┐   <wake>   ┌──────────┐  <Poll::Ready>
 ──────────▶│  ENQUEUE │───────────▶│  ACTIVE   │────────────▶│  TRANSFER  │───────────▶│  FINISH  │────────────────▶ ...
             └─────────┘             └───────────┘              └────────────┘            └──────────┘
                    I2CTransfer control                            IRQ control              I2CTransfer
           └────────────────────────────────────────────┘└──────────────────────────┘└────────────────────────┘
```

So now we know what to transfer and can initiate and finish the transfer. The only thing missing is remembering at what darn point of the transfer we are at. Remember: the IRQ is not stateful, we do not know anything about any previous times we have been triggered. So, how do we remember the previous state in a global function? That's right, a (not `pub`) `static mut`. We use this with a `struct` just containing some indices of which operations are done, and from those operations, which bytes have already been transfered. Now, a lot of people will have their hand on their head. But, we cannot use `static mut`, it's illegal. Well, shall I remind you that an IRQ, by design, is hardware enforced to only be running at once. There cannot be many instances of the function being called (at least in one core) concurrently so no concurrent access (from the IRQ) can happen. And because after arming the IRQ we are guaranteed by the contract that all data is owned by the IRQ (the `I2CTransfer` will reset the state before arming) we can ""_safely_"" access this data.

Great, we have all we need, let's get to it. Turns out, once you have handled the pesky high level, correctness stuff, the I2C itself is quite simple. Just load data when a new byte (read or write) is needed, set the appropiate flags and get data when available. This plus a couple of checks for errors in the device (e.g. NACK or timeouts). All in all, a handful of `if`s, a couple of `while` loops and we are done. We have a functional I2C IRQ that can send data. Now we just need to handle the userland stuff.

```rust
#[unsafe(link_section = ".bss")]
static mut STATE: [[usize; 4]; 2] = [[0; 4]; 2];

#[inline(never)]
pub(crate) unsafe extern "C" fn handler<const N: usize>() {
    return inner(N);
}

#[inline(never)]
unsafe extern "C" fn inner(instance: usize) {
    let peripheral = /* Get here a reference to the register block */;
    let transfer: &mut I2CTransfer = match QUEUE[instance].current() {
        Some(mut pointer) => pointer.as_mut(),
        None => /* Disable the peripheral */,
    };

    if let Some(abort) = peripheral.abort() {
        /* Set the error in the I2CTransfer and disable the device */
    }

    // Get the state of the current transfer and execute it.
    let [wridx, wrbyte, rdidx, rdbyte] = STATE[instance];
    ...
}
```

Turns out this part is also quite easy (although memory size intensive). We just implement `embedded_async_hal::...::I2CDevice` for the `I2CDevice` and done. We create a new `await`able `I2CTransfer`, use it as the node in the multicore `Queue` and implement the logic to queue and dequeue work from there. That looks easy, should be hammered out in a couple hours.

...

...

**WRONG!!!!**

Well you see, I had made a decision in the beginning of development. I thought about what happens when one of the cores just starts spamming the I2C bus. What would happen? If there is only one core handling the IRQ, that core might be starved of CPU resources and, well, die I guess? So to avoid this I had the `I2CTransfer` enable the IRQ for the requesting core, and then disabling it when it finishes. This way, if a CPU core wants to spam the bus, it can be a big boy and handle its own transfer. Well, apparently this causes a shitton of issues in syncrhoization, setting the correct state, ghost triggers in cores and a host of other issues. After 2 weeks of breaking my brains over it (and I admit that I even threw the whole problem to Fable to see what would happen (spoilers, even it got lost, the great Fable, defeated by Synopsis shitty IP)) I just decided that was a stupid decision and the best way was to pin the IRQ to a core (allowing the user to decide which core) and expect the user of the HAL (I know him, that's me) to not starve one of the cores.

Once I implemented this change, oh, surprise, it worked like a charm. Well, not a charm, more like a 50 year old car that has been sitting in the sun too long. You see, `loop`s (even bounded loops like `while` and `for`) are really bad in IRQ contexts, like really really bad. Specially if you don't have superscalar CPUs with amazing branch predictors (and even then, `loop` bad in IRQ). I was netting 4000 cycles [^2] per IRQ invokation (take into account there are at least 2 invokations per transfer: first to load data and one last one to finish the transfer). Turns out, my logic of chomping the bytes of transfer one by one does not work. The I2C peripheral in the RP2350 has a 16 deep FIFO for data, and I was just going with the write or read bytes and writing or reading them one by one, checking the state between them and doing all sorts of operation. Not my best moment. So I took out all operations of the loops. I calculated how many bytes could I hammer into the FIFO at each IRQ call (really nice pair of registers called `(TX|RX) FIFO Level` helped here), handled all state outside the loops and did as many early returns as humanly possible, I got the IRQ down to 400 cycles in the slowest path (read + write mixed transfer). Write only transfers were down to 200 cycles and failed transfers (error / panic path) down to 50-75 cycles (without the IRQ latency).

| IRQ path                          | Cycles / IRQ | Cycles / transfer | Time @ 150 MHz | Reduction |
|-----------------------------------|--------------|-------------------|----------------|-----------|
| Initial (byte-by-byte loops)      | ~4000        | ~8000             | ~50 µs         | -         |
| Optimized: read + write (slowest) | ~400         | ~800              | ~5 µs          | 10x       |
| Optimized: write only             | ~200         | ~400              | ~2.5 µs        | 20x       |
| Optimized: error / panic path     | 50-75        | ~250              | ~1 µs          | 53-80x    |

Right, that oughtta do it. So now we have a backup IRQ path, we know how to use the I2C peripheral and we have tested that we can talk with devices (I used a spare LSM303 I had lying around). Sweet, so after 3 weeks of (very interrupted) work, we are now ready to start on the DMA handler... yay...

## Finally building the DMA path

Well, now we need to see how we can transform all of that work we previously did with the CPU, with the conditionals and everything, and transform it into something digestible by the DMA (plus the transform from 8 bit data to 16 bit data). After a bit of scrounging my brain for ideas, I gave up. You see, I'm already using `unsafe` `static mut` a lot and I have a backup IRQ. So I decided that, to enable DMA in the I2C, you would have to pass to the driver, at build time, three things: Write DMA channel, Read DMA channel and a static buffer of `&'static [u16]`[^3]. This buffer will determine the maximum size that can be sent by DMA, and anything exceeding that will be handled in the IRQ path. Simple, easy to follow rules and the user can choose the size. Solved. Let's go home.

To handle the data paths, we just check if we can do DMA or IRQ at creation of the `I2CTransfer` (more on this later) and set the path in the flags. If we can do the DMA path, once the transfer is active, the data from the operations is loaded into the driver buffer and the correct transition flags (which are set in the same register as data, go ask Synopsis why they didn't just make a read and a write separate registers). After that we set the DMA channels to trigger the I2C callback once they complete and launch them. And then we wait. Once the DMA channels finish they will trigger the I2C IRQ.

So back to the IRQ, we now need to check in the `I2CTransfer` if it is using the DMA path and, if so, go into a specific handling. You see, when in DMA path we only care about two events in the bus: error and completion. Everything else is handled already. The errors are already checked in the shared path with the IRQ based transfer, so we just need to check if both channels have completed and wake the `I2CTransfer` (plus some maintenance on the DMA channels if there was an abort). This leaves us with a leanish IRQ, that only triggers once at the end of the transfer. In the end this leaves this path quite lean, with only ~200 cycles of CPU time. But I kinda felt this was not correct, didn't feel right. So I decided to check just how much work is done in the `I2CTransfer` `Future`. And boyyyyyy is there juice here.

Turns out our `I2CTransfer` `Future` is doing 1200 cycles of work on every transfer. WOW. Not a lot in the scheme of things, but more than I expected. So I compared it to the IRQ path. And, well, it's interesting. The IRQ path is doing around 400 cycles of work, mainly spent ensuring all the state of the driver is set correctly before loosing control. So let's do a quick comparison.

| Path | Preparation  | Total IRQ time | Total time |
|------|--------------|----------------|------------|
| DMA  | ~1200 cycles | ~200           | 1400       |
| IRQ  | ~400 cycles  | ~800 (minimum) | 1200       |

So it turns out they are doing more or less the same amount of work. Up, down 200 cycles is not much. But the main distinction is **where** the cycles are spent and how. In DMA mode, the bulk of the cycles are spent in usermode. This means there is no other IRQ waiting to be fired and blocked. All other work in the CPU core can go on. On the other hand, the IRQ path spends at least 800 cycles (2/3 of the time) in IRQ mode, possibly blocking other IRQs from doing timely work. This is the first note to take from this analysis. Second point is how many times will the IRQ trigger. In DMA mode you get a bounded state, no matter how much data you are pushing, 16 bytes or 16 kiB, it will al be handled in 1200 cycles of CPU time and two abused DMA channels. But in IRQ mode this CPU time grows linearly with the amount of bytes transfered. Quick estimation: 400 + (400 * N / 16) where N is the amount of bytes. Any transfer size multiple of 16 bytes (the FIFO size of the I2C peripheral) will have to trigger an additional IRQ to handle the extra data.

As a general rule for myself: If I'm doing small data transfers, less than 16 bytes (for example, reading out IMU data), just use the IRQ mode. Less resources spent and similar time all in all. But if I'm transfering large amounts of data (display data, logs, etc...) use DMA, it will make life easier.

## Putting it to the test

To test it I will use the aforementioned LSM303 accelerometer + magnetometer I had laying around, which also includes in the board a L3GD20 gyroscope. Set up was standard, get the pins, get the interrupt pins, make the I2C abstractions, configure the devices and wait for pin low to read the data. Bam, we have sensor acquisition tasks.

What I want to point to is the performance. Configuring the sensors for a bit high performance data acquisition rate for a drone, I set the accelerometer at 1300 Hz, the gyroscope at 400 Hz and the magnetometer at 75 Hz. Each sensor readout transfers 1 Address Byte + 1 Register Address Byte + 6 Data Bytes for a total of 8 bytes of data. Including framing and protocol and bells and whistles (ACK, NACK, STOP, RESTART, etc...) let's say an even 10. We cannot know if there is clock stretching from software and I'm not motivated enough to take out the oscilloscope right now, so let's assume there is no clock stretching (for now). At the 400 kHz speed that these sensors support we are getting all the data on time at the desired rate (with some clock drift), which means 6 bytes * (1300 + 400 + 75) = 10.65 kB/s (85.2 kb/s) of data over the bus, with a CPU usage of... _drum roll_ ... **0.4%**!!!! (there were some background tasks for housekeeping but those are irrelevant). Not bad, I'm even a bit proud of it.

And to really put the interface to the test, I had the amazing idea of disconnecting the IMU and then reconnecting using a bad power source, which, turns out, fried completely the Z axis magnetometer, leaving it always returning 0xFF data and, even worse, leaving the interrupt pin always high. This made it so the sensor task was always asserted and reading data at the maximum speed it could (2400 Hz). Even so, the other sensor tasks managed to read at the desired rate, showing just how resilient both the driver and the `embassy` `Executor` are with non-cooperative tasks. At this new speed, the driver is reading 6 bytes * (1300 + 400 + 2400) = 24.6 kB/s (196.8 kb/s). So basically we are using 50% of all available data bandwidth of the bus. If we start to take into account protocol overhead (+3 bytes) it goes up to 36.9 kB/s (295.2 kb/s), 73% of the bus capacity. At this point, for such short transfers, with repeating address call and framing overhead, I would hazard it's about as good as it gets, leaving me content with the state of the I2C driver and ready to move onto different subsystems. And to make things even better, this 73% bus capacity was achieved with only a 10% CPU load on the core handling the I2C driver. We can see here that the load grows at a faster rate than the bus usage, but this is mainly due to the bigger amount of contention and synchronization needed in this case.

## Other work and closing thoughts

I talked at some point about having a bound maximum size of a transfer. I briefly considered using the buffer as an arena allocator of sorts, where each transfer would try to grab the amount of bytes it needed at creation and reserve them. Although this works in reducing the latency of actually triggering the transfer when there is a lot of contention for the bus, it leads to non-intuitive behavior of the driver (e.g. a user gives a 64 byte buffer but then get sporadically transfers less than 64 bytes handled via IRQ). Thus this approach was discarded.

All in all, I'm happy with the final state of the driver and I'm already using it in my own projects. The two things I have seen are: low CPU and more comfortable coding due to the **enourmous** amount of Rust `type`s that I write in my code (or that I don't anymore with this new driver).

That'll be all today. See you around and stay tuned for more `unsafe` adventures.

[^1]: The references are enforced valid via the way the data flows and how we transition from one state of an I2C transfer to the next. To the borrow checker these should be invalid, so we do a bit of `unsafe` tricking to calm it down. This is doable, not the best practice but with care we can make it work.
[^2]: Cycle count is done with an internal utility that measures cycles with the Systick tied to System Clock.
[^3]: How the user will be able to give the driver a `static mut` buffer, I leave that to the future. There are many ways to do this in _safeish_ Rust, not gonna dwell in it.