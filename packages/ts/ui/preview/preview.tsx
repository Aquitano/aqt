import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@aqt/ui/components/accordion";
import { Alert, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@aqt/ui/components/alert-dialog";
import { Avatar, AvatarFallback, AvatarGroup } from "@aqt/ui/components/avatar";
import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { ButtonGroup } from "@aqt/ui/components/button-group";
import { Card, CardContent, CardHeader, CardTitle } from "@aqt/ui/components/card";
import { Checkbox } from "@aqt/ui/components/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aqt/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@aqt/ui/components/field";
import { Input } from "@aqt/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@aqt/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@aqt/ui/components/item";
import { Kbd } from "@aqt/ui/components/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@aqt/ui/components/popover";
import { Progress } from "@aqt/ui/components/progress";
import { RadioGroup, RadioGroupItem } from "@aqt/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aqt/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@aqt/ui/components/sheet";
import { Skeleton } from "@aqt/ui/components/skeleton";
import { Slider } from "@aqt/ui/components/slider";
import { Spinner } from "@aqt/ui/components/spinner";
import { Switch } from "@aqt/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aqt/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aqt/ui/components/tabs";
import { Textarea } from "@aqt/ui/components/textarea";
import { ThemeProvider } from "@aqt/ui/components/theme-provider";
import { ThemeToggle } from "@aqt/ui/components/theme-toggle";
import { ToggleGroup, ToggleGroupItem } from "@aqt/ui/components/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@aqt/ui/components/tooltip";
import {
  BookmarkIcon,
  InboxIcon,
  InfoIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Charts } from "./charts";

const LIGHT_TEXT = "oklch(0.985 0 0)";
const DARK_TEXT = "oklch(0.205 0 0)";

const ACCENTS = [
  { name: "Neutral", color: null, foreground: null },
  { name: "Blue", color: "oklch(0.55 0.2 262)", foreground: LIGHT_TEXT },
  { name: "Orange", color: "oklch(0.64 0.19 42)", foreground: DARK_TEXT },
  { name: "Green", color: "oklch(0.6 0.15 155)", foreground: DARK_TEXT },
  { name: "Violet", color: "oklch(0.56 0.22 295)", foreground: LIGHT_TEXT },
] as const;

const PROVIDERS = [
  { label: "Claude Code", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "Gemini CLI", value: "gemini" },
];

const REQUESTS = [
  { model: "claude-opus-5-5", requests: 1204, cost: "$812.40" },
  { model: "gpt-5.4", requests: 388, cost: "$214.06" },
  { model: "gemini-3-pro", requests: 97, cost: "$41.18" },
];

function applyAccent(name: string) {
  const accent = ACCENTS.find((candidate) => candidate.name === name);
  const root = document.documentElement.style;
  if (accent?.color) {
    root.setProperty("--brand", accent.color);
    root.setProperty("--brand-foreground", accent.foreground);
  } else {
    root.removeProperty("--brand");
    root.removeProperty("--brand-foreground");
  }
}

function AccentPicker() {
  const [accent, setAccent] = useState("Neutral");

  return (
    <ToggleGroup
      variant="outline"
      size="sm"
      value={[accent]}
      onValueChange={(value) => {
        const [next] = value;
        if (next) {
          setAccent(next);
          applyAccent(next);
        }
      }}
    >
      {ACCENTS.map(({ name, color }) => (
        <ToggleGroupItem key={name} value={name} aria-label={name}>
          <span
            className="size-3 rounded-full ring-1 ring-foreground/20"
            style={{ background: color ?? "var(--foreground)" }}
          />
          {name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">{title}</h2>
      {children}
    </section>
  );
}

function Controls() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Buttons and badges</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button>Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Delete</Button>
            <Button variant="link">Link</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">
              <PlusIcon />
              Small
            </Button>
            <Button>
              <SearchIcon />
              Search
            </Button>
            <Button size="lg">Large</Button>
            <Button size="icon" variant="outline" aria-label="Settings">
              <SettingsIcon />
            </Button>
            <Button disabled>
              <Spinner />
              Saving
            </Button>
          </div>
          <ButtonGroup>
            <Button variant="outline">Day</Button>
            <Button variant="outline">Week</Button>
            <Button variant="outline">Month</Button>
          </ButtonGroup>
          <div className="flex flex-wrap gap-2">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
          </div>
          <Progress value={64} />
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Form</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="album">Album name</FieldLabel>
              <Input id="album" placeholder="Lisbon 2026" />
              <FieldDescription>Shown on the cover.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="search">Search</FieldLabel>
              <InputGroup>
                <InputGroupInput id="search" placeholder="Model, project or prompt" />
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupAddon align="inline-end">
                  <Kbd>Ctrl K</Kbd>
                </InputGroupAddon>
              </InputGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="provider">Provider</FieldLabel>
              <Select items={PROVIDERS} defaultValue="claude">
                <SelectTrigger id="provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {PROVIDERS.map((provider) => (
                      <SelectItem key={provider.value} value={provider.value}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field orientation="horizontal">
              <Switch id="sync" defaultChecked />
              <FieldLabel htmlFor="sync">Sync every hour</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="redact" defaultChecked />
              <FieldLabel htmlFor="redact">Redact secrets before upload</FieldLabel>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Density</FieldLegend>
              <RadioGroup defaultValue="comfortable">
                <Field orientation="horizontal">
                  <RadioGroupItem value="compact" id="compact" />
                  <FieldLabel htmlFor="compact">Compact</FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem value="comfortable" id="comfortable" />
                  <FieldLabel htmlFor="comfortable">Comfortable</FieldLabel>
                </Field>
              </RadioGroup>
            </FieldSet>
            <Field>
              <FieldLabel id="budget-label">Monthly budget</FieldLabel>
              <Slider aria-labelledby="budget-label" defaultValue={[60]} max={100} />
            </Field>
            <Field>
              <FieldLabel htmlFor="notes">Notes</FieldLabel>
              <Textarea id="notes" placeholder="Anything worth remembering" />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  );
}

function Feedback() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Alert>
          <InfoIcon />
          <AlertTitle>Pricing refreshed</AlertTitle>
          <AlertDescription>412 requests were repriced under the new catalog.</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Sync failed</AlertTitle>
          <AlertDescription>The machine token for the laptop expired.</AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Dialog />
          <Sheet>
            <SheetTrigger render={<Button variant="outline" />}>Sheet</SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Request inspector</SheetTitle>
                <SheetDescription>Tokens, cost and timing for one model request.</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
          <Popover>
            <PopoverTrigger render={<Button variant="outline" />}>Popover</PopoverTrigger>
            <PopoverContent>Filters for the current view.</PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" />}>Tooltip</TooltipTrigger>
            <TooltipContent>Bookmarked conversations stay at the top.</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InboxIcon />
          </EmptyMedia>
          <EmptyTitle>No bookmarks yet</EmptyTitle>
          <EmptyDescription>Bookmark a conversation to find it here later.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm">Browse conversations</Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function Dialog() {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" />}>Alert dialog</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this machine?</AlertDialogTitle>
          <AlertDialogDescription>
            Its token stops working and its records stay in the archive.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Data() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardContent>
          <Tabs defaultValue="models">
            <TabsList>
              <TabsTrigger value="models">Models</TabsTrigger>
              <TabsTrigger value="machines">Machines</TabsTrigger>
            </TabsList>
            <TabsContent value="models">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {REQUESTS.map((row) => (
                    <TableRow key={row.model}>
                      <TableCell className="font-mono">{row.model}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.requests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.cost}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="machines">Two machines synced in the last hour.</TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        <Item variant="outline">
          <ItemMedia>
            <AvatarGroup>
              <Avatar>
                <AvatarFallback>TB</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>AQ</AvatarFallback>
              </Avatar>
            </AvatarGroup>
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Invoice for September</ItemTitle>
            <ItemDescription>billing@hetzner.com, two attachments</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button size="icon" variant="ghost" aria-label="Bookmark">
              <BookmarkIcon />
            </Button>
          </ItemActions>
        </Item>
        <Accordion defaultValue={["what"]}>
          <AccordionItem value="what">
            <AccordionTrigger>What does the agent collect?</AccordionTrigger>
            <AccordionContent>
              Local transcripts from each coding tool, with known secret formats redacted.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="where">
            <AccordionTrigger>Where are records stored?</AccordionTrigger>
            <AccordionContent>On one server, in Postgres.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );
}

export function Preview() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <div className="min-h-svh bg-background text-foreground">
          <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-background/80 px-6 py-3 backdrop-blur">
            <span className="font-medium">@aqt/ui</span>
            <AccentPicker />
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </header>
          <main className="mx-auto flex max-w-6xl flex-col gap-10 p-6">
            <Section title="Charts">
              <Charts />
            </Section>
            <Section title="Controls">
              <Controls />
            </Section>
            <Section title="Feedback and overlays">
              <Feedback />
            </Section>
            <Section title="Data">
              <Data />
            </Section>
          </main>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
